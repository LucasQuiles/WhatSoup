import contextlib
import io
import json
import os
import pathlib
import plistlib
import sys
import time
import types
from unittest.mock import patch
from tempfile import TemporaryDirectory

import pytest
from hypothesis import given, strategies as st

FLEET = pathlib.Path(__file__).resolve().parents[1]
LIB = FLEET.parent / "lib"
ROOT = FLEET
HEALTH_READER = LIB / "health_reader.py"

def adapter():
    module = types.ModuleType("fleet_probe_adapter")
    module.__dict__["__file__"] = str(ROOT / "fleet_probe.py")
    exec(compile((ROOT / "fleet_probe.py").read_text(), "adapter", "exec"), module.__dict__)
    return module

def remote_probe(tmp_path, statuses, warmer=False, instances=None):
    request = {
        'instances': instances or [], 'broker': 'legacy', 'warmer': warmer,
        'health_reader_code': HEALTH_READER.read_text(),
    }
    def respond(req, timeout):
        status, body = statuses[req.full_url.rsplit('/', 1)[-1]]
        response = io.BytesIO(json.dumps(body).encode())
        response.status = status
        return response
    output = io.StringIO()
    with patch.object(sys, 'argv', ['probe', json.dumps(request)]), patch('pathlib.Path.home', return_value=tmp_path), patch('urllib.request.urlopen', side_effect=respond), contextlib.redirect_stdout(output):
        exec(compile((ROOT/'fleet_probe_remote.py').read_text(), 'remote', 'exec'), {})
    return json.loads(output.getvalue())


def test_missing_legacy_readiness_is_unknown_and_explicit_failure_stays_false(tmp_path):
    health = (200, {'status': 'ok'})
    unknown = remote_probe(tmp_path, {'health': health, 'ready': (404, {'detail':'Not Found'})})
    assert unknown['checks']['broker_legacy_health'] is True
    assert unknown['checks']['broker_ready'] is None
    assert 'broker_readiness_endpoint_unsupported' in unknown['codes']
    failed = remote_probe(tmp_path, {'health': health, 'ready': (503, {'status':'unready'})})
    assert failed['checks']['broker_ready'] is False


def test_expired_legacy_warmer_is_separate_from_healthy_broker(tmp_path):
    path = tmp_path / 'LAB/Agent365/data/warmer/state.json'
    path.parent.mkdir(parents=True)
    import datetime
    path.write_text(json.dumps({'updated_at':datetime.datetime.now(datetime.timezone.utc).isoformat(), 'accounts':{'one':{'fail_streak':4,'last_fail_reason':'invalid_grant'}}}))
    result = remote_probe(tmp_path, {'health':(200,{'status':'ok'}),'ready':(200,{'status':'ready'})}, warmer=True)
    assert result['checks']['broker_ready'] is True
    assert result['checks']['legacy_warmer_fresh'] is True
    assert result['checks']['legacy_warmer_authenticated'] is False


def broker_probe(tmp_path, request, launch_agent=True):
    """Run the probe beside a broker service plist and both credential files.

    Return the probe output, every URL requested, every command run and every
    file read, so a test sees all the probe touched.
    """
    import plistlib
    env = tmp_path/'service.env'
    env.write_text('AGENT365_API_KEY=fake\n')
    legacy = tmp_path / 'LAB/Agent365/.env'
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text('AGENT365_API_KEY=fake\n')
    if launch_agent:
        agents = tmp_path/'Library/LaunchAgents'
        agents.mkdir(parents=True)
        (agents/'com.agent365.service.plist').write_bytes(plistlib.dumps({'Label': 'com.agent365.service', 'ProgramArguments': ['/bin/agent365', '--env-file', str(env)], 'RunAtLoad': True, 'KeepAlive': True}))
    request = {'instances': [], **request, 'health_reader_code': HEALTH_READER.read_text()}
    code = (ROOT/'fleet_probe_remote.py').read_text()
    urls, ran, reads = [], [], []
    # The stand-in broker answers every path; http() swallows errors, so only
    # this list shows whether a request was made.
    def respond(req, timeout):
        urls.append(req.full_url)
        body = {'status': 'ready'} if req.full_url.endswith('/ready') else {'status': 'ok'}
        response = io.BytesIO(json.dumps(body).encode())
        response.status = 200
        return response
    def run_command(command, **kwargs):
        ran.append(command[0])
        return types.SimpleNamespace(returncode=0, stdout=b'')
    real_text, real_bytes = pathlib.Path.read_text, pathlib.Path.read_bytes
    def read_text(self, *args, **kwargs):
        reads.append(self)
        return real_text(self, *args, **kwargs)
    def read_bytes(self):
        reads.append(self)
        return real_bytes(self)
    output = io.StringIO()
    with patch.object(sys, 'argv', ['probe', json.dumps(request)]), patch('pathlib.Path.home', return_value=tmp_path), patch('urllib.request.urlopen', side_effect=respond), patch('subprocess.run', side_effect=run_command), patch.object(pathlib.Path, 'read_text', read_text), patch.object(pathlib.Path, 'read_bytes', read_bytes), contextlib.redirect_stdout(output):
        exec(compile(code, 'remote', 'exec'), {})
    return json.loads(output.getvalue()), urls, ran, reads


# Synthetic targets exercise an explicit retirement list. The observer must
# forget retired checks and clear any incidents they opened, while it leaves
# unretired capability checks intact.
RETIRED_HOST_CHECKS = ['broker_persistent', 'broker_loaded', 'broker_http_responsive', 'broker_legacy_health', 'broker_liveness', 'broker_ready', 'isolated_canary_liveness']
RETIRED_BY_HOST = {
    'retired-host': RETIRED_HOST_CHECKS,
    'node-a': ['broker_persistent', 'broker_loaded', 'broker_liveness', 'broker_ready'],
    'node-d': ['broker_ready'],
    'node-c': ['legacy_warmer_authenticated', 'legacy_warmer_fresh'],
}


def test_retired_host_target_makes_no_broker_or_canary_call_and_passes_its_retired_checks(tmp_path):
    # A synthetic retired target runs beside fixture service files.
    target = {"target": "retired-host", "instances": [], "broker": None, "retired_checks": RETIRED_HOST_CHECKS}
    canary = tmp_path/'.config/agent365-canary/service.env'
    canary.parent.mkdir(parents=True)
    canary.write_text('AGENT365_API_KEY=fake\n')
    result, urls, ran, reads = broker_probe(tmp_path, target)
    assert result['retired_checks'] == RETIRED_HOST_CHECKS
    assert not [c for c in result['checks'] if c.startswith(('broker_', 'isolated_canary_'))]
    assert 'retired_check_name_invalid' not in result['codes']
    # Nothing on port 10000 or 11000, and no broker or canary credential read.
    assert urls == []
    assert ran == []
    assert reads == []


@pytest.mark.parametrize('host', ['node-a', 'node-c'])
def test_a_section_feeding_only_retired_checks_is_not_probed(tmp_path, host):
    # The real target's broker and warmer settings, run beside the old broker
    # plist, credential files and warmer state: no port-10000 call, no
    # launchctl and no file read. Its bot and m365 sections are tested elsewhere.
    target = {"node-a": {"broker": None, "retired_checks": RETIRED_BY_HOST[host]}, "node-c": {"broker": None, "retired_checks": RETIRED_BY_HOST[host]}}[host]
    warmer = tmp_path / 'LAB/Agent365/data/warmer/state.json'
    warmer.parent.mkdir(parents=True)
    warmer.write_text(json.dumps({'updated_at': '2026-07-14T00:00:00+00:00', 'accounts': {}}))
    result, urls, ran, reads = broker_probe(tmp_path, {**target, 'instances': [], 'm365': False})
    assert result['retired_checks'] == RETIRED_BY_HOST[host]
    assert not [c for c in result['checks'] if c.startswith(('broker_', 'legacy_warmer_'))]
    assert (urls, ran, reads) == ([], [], [])


def test_retired_checks_pass_through_unchanged(tmp_path):
    result, urls, ran, reads = broker_probe(tmp_path, {'broker': None, 'retired_checks': RETIRED_HOST_CHECKS})
    assert result['retired_checks'] == RETIRED_HOST_CHECKS
    assert result['checks'] == {'ssh_reachable': True}
    assert result['codes'] == []
    assert (urls, ran, reads) == ([], [], [])


def test_target_without_retired_checks_sends_none(tmp_path):
    result, urls, ran, reads = broker_probe(tmp_path, {'broker': None})
    assert 'retired_checks' not in result
    assert result['codes'] == []


@pytest.mark.parametrize('retired, kept', [
    (['broker_ready', 'Broker_Ready', '', 'a'*81, 'x y', 7, None, 'broker_ready\n', '_lead', 'a'*80], ['broker_ready', 'a'*80]),
    (['-lead', 'broker.ready'], []),
    ('broker_ready', []),
    ({'broker_ready': True}, []),
], ids=['mixed', 'all-invalid', 'string-not-list', 'dict-not-list'])
def test_invalid_retired_check_names_are_dropped_and_coded(tmp_path, retired, kept):
    # Each name must match the observer's check-name pattern; anything else is
    # dropped, never passed on, and coded once.
    result, urls, ran, reads = broker_probe(tmp_path, {'broker': None, 'retired_checks': retired})
    assert result['retired_checks'] == kept
    assert result['codes'] == ['retired_check_name_invalid']


@pytest.mark.parametrize('broker, launch_agent, paths, expected', [
    ('legacy', True, ['health', 'ready'], {'broker_persistent', 'broker_loaded', 'broker_http_responsive', 'broker_legacy_health', 'broker_ready'}),
    ('legacy', False, ['health', 'ready'], {'broker_http_responsive', 'broker_legacy_health', 'broker_ready'}),
    ('attested', True, ['live', 'ready'], {'broker_persistent', 'broker_loaded', 'broker_liveness', 'broker_ready'}),
], ids=['legacy', 'legacy-no-launch-agent', 'attested'])
def test_live_broker_is_still_probed(tmp_path, broker, launch_agent, paths, expected):
    result, urls, ran, reads = broker_probe(tmp_path, {'broker': broker}, launch_agent)
    checks = result['checks']
    assert {c for c in checks if c.startswith('broker_')} == expected
    assert all(checks[c] is True for c in expected)
    assert urls == ['http://127.0.0.1:10000/' + p for p in paths]
    assert ran == (['/bin/launchctl'] if launch_agent else [])
    # The credential it sends comes from the plist's env file, or else the legacy .env.
    assert tmp_path / ('service.env' if launch_agent else 'LAB/Agent365/.env') in reads


def test_explicit_synthetic_inventory_preserves_retired_checks(tmp_path):
    inventory = tmp_path / "fleet-targets.json"
    inventory.write_text(json.dumps({"schema_version": 1, "hosts": {
        "retired-host": {
            "target": "operator@retired-host",
            "instances": ["demo-bot", "secondary-bot"],
            "retired_checks": RETIRED_HOST_CHECKS,
        }
    }}))
    module = types.ModuleType("fleet_probe_adapter")
    module.__dict__["__file__"] = str(ROOT / "fleet_probe.py")
    exec(compile((ROOT / "fleet_probe.py").read_text(), "adapter", "exec"), module.__dict__)
    target = module.load_target(inventory.resolve(), "retired-host")
    assert target["instances"] == ["demo-bot", "secondary-bot"]
    assert target["retired_checks"] == RETIRED_HOST_CHECKS


def test_synchronous_remote_observation_uses_local_completion_clock():
    future=time.time()+300
    remote={'checked_at':future,'checks':{'ssh_reachable':True},'codes':[]}
    result=types.SimpleNamespace(returncode=0,stdout=json.dumps(remote).encode())
    before=time.time()
    with patch('subprocess.run',return_value=result):
        observed=adapter().run_target({'local': True})
    assert before<=observed['checked_at']<=time.time()
    assert observed['checks']==remote['checks']


def test_primary_model_health_distinguishes_failure_from_stale_success(tmp_path):
    config = tmp_path/'.config/whatsoup/instances/bot/config.json'
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({'healthPort':9090}))
    (config.parent/'tokens.env').write_text('WHATSOUP_HEALTH_TOKEN=test\n')
    for usable, stale, expected in [(False,False,False),(True,False,True),(True,True,None),(None,False,None)]:
        body={'status':'healthy','whatsapp':{'connected':True},'runtime':{'agent':{}},'turn_capability':{'model_usable':usable,'model_usable_stale':stale,'model_usability_status':'credential-unavailable' if usable is False else 'usable'}}
        with patch.object(sys,'platform','darwin'):
            result=remote_probe(tmp_path, {'health':(200,body),'ready':(200,{'status':'ready'})},instances=['bot'])
        assert result['checks']['bot_primary_model_usable'] is expected


@pytest.mark.parametrize("override,shared,file_token,expected", [
    ("instance-token", "shared-token", "file-token", "instance-token"),
    ("", "shared-token", "file-token", "shared-token"),
    ("", "", "file-token", "file-token"),
    ("", "", "", "legacy-token"),
])
@given(suffix=st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789", min_size=1, max_size=30))
def test_remote_health_uses_canonical_token_precedence_with_legacy_plist_fallback(override, shared, file_token, expected, suffix):
    override = override + suffix if override else ""
    shared = shared + suffix if shared else ""
    file_token = file_token + suffix if file_token else ""
    expected += suffix
    with TemporaryDirectory() as directory:
        tmp_path = pathlib.Path(directory)
        config = tmp_path / ".config/whatsoup/instances/example-bot/config.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"healthPort": 9090}))
        if file_token:
            (config.parent / "tokens.env").write_text("WHATSOUP_HEALTH_TOKEN=" + file_token + "\n")
        plist = tmp_path / "Library/LaunchAgents/com.whatsoup.example-bot.plist"
        plist.parent.mkdir(parents=True)
        plist.write_bytes(plistlib.dumps({"RunAtLoad": True, "KeepAlive": True,
                                         "EnvironmentVariables": {"WHATSOUP_HEALTH_TOKEN": "legacy-token" + suffix}}))
        request = {"instances": ["example-bot"], "health_reader_code": HEALTH_READER.read_text()}

        def respond(req, timeout):
            accepted = req.get_header("Authorization") == "Bearer " + expected
            body = {"whatsapp": {"connected": True}} if accepted else {"schema_version": "health.public.v1"}
            response = io.BytesIO(json.dumps(body).encode())
            response.status = 200
            return response

        output = io.StringIO()
        environment = {"BOT_ERRORS_HEALTH_TOKEN_EXAMPLE_BOT": override, "WHATSOUP_HEALTH_TOKEN": shared}
        with patch.dict(os.environ, environment), patch.object(sys, "argv", ["probe", json.dumps(request)]), patch("pathlib.Path.home", return_value=tmp_path), patch("urllib.request.urlopen", side_effect=respond), contextlib.redirect_stdout(output):
            exec(compile((ROOT / "fleet_probe_remote.py").read_text(), "remote", "exec"), {})
        result = json.loads(output.getvalue())
        assert result["checks"]["example_bot_health_readable"] is True
        assert result["checks"]["example_bot_whatsapp_connected"] is True


@pytest.mark.parametrize("platform", ["linux", "darwin"])
def test_remote_system_manager_probe_is_linux_only(tmp_path, platform):
    config = tmp_path / ".config/whatsoup/instances/bot/config.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({"healthPort": 9090}))
    completed = types.SimpleNamespace(returncode=0, stdout="UnitFileState=enabled\nRestart=always\nActiveState=active\n")
    with patch.object(sys, "platform", platform), patch("subprocess.run", return_value=completed) as command:
        result = remote_probe(tmp_path, {"health": (200, {"status": "ok"}), "ready": (200, {"status": "ready"})}, instances=["bot"])
    if platform == "linux":
        command.assert_called_once()
        assert command.call_args.args[0][0] == "systemctl"
        assert result["checks"]["bot_persistent"] is True
    else:
        command.assert_not_called()
        assert "bot_persistent" not in result["checks"]


def test_primary_model_check_carries_the_bot_probe_stamp_as_evidence(tmp_path):
    # The observer counts a repeated failure only when this stamp is new, so a
    # bot probe result read on several cycles is one failure, not several.
    config = tmp_path/'.config/whatsoup/instances/bot/config.json'
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({'healthPort':9090}))
    (config.parent/'tokens.env').write_text('WHATSOUP_HEALTH_TOKEN=test\n')
    for stamp, expected in [(1791428785654,1791428785654),(1791428785654.5,1791428785654.5),(None,None),(True,None),('1791428785654',None),(float('nan'),None),(10**16,None),(10**17,None),(-1e16,None)]:
        capability={'model_usable':False,'model_usable_stale':False,'model_usability_status':'timeout','model_usable_freshness_ms':1800000}
        if stamp is not None:capability['model_usable_checked_at']=stamp
        body={'status':'healthy','whatsapp':{'connected':True},'runtime':{'agent':{}},'turn_capability':capability}
        with patch.object(sys,'platform','darwin'):
            result=remote_probe(tmp_path, {'health':(200,body),'ready':(200,{'status':'ready'})},instances=['bot'])
        assert result['checks']['bot_primary_model_usable'] is False
        assert result['evidence'].get('bot_primary_model_usable')==expected if expected is not None else 'bot_primary_model_usable' not in result['evidence']
        json.dumps(result,allow_nan=False)


def test_no_evidence_from_a_bot_without_the_scheduled_freshness_window(tmp_path):
    # Before the legacy behavior a failed result turns stale at a flat 30 min, before the
    # bot's next probe, so stamped counting would never reach critical there. Such a
    # bot (no model_usable_freshness_ms) keeps the per-read count: no evidence.
    config = tmp_path/'.config/whatsoup/instances/bot/config.json'
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({'healthPort':9090}))
    (config.parent/'tokens.env').write_text('WHATSOUP_HEALTH_TOKEN=test\n')
    for window in ('absent', None, True, '1800000'):
        capability={'model_usable':False,'model_usable_stale':False,'model_usability_status':'timeout','model_usable_checked_at':1791428785654}
        if window!='absent':capability['model_usable_freshness_ms']=window
        body={'status':'healthy','whatsapp':{'connected':True},'runtime':{'agent':{}},'turn_capability':capability}
        with patch.object(sys,'platform','darwin'):
            result=remote_probe(tmp_path, {'health':(200,body),'ready':(200,{'status':'ready'})},instances=['bot'])
        assert result['checks']['bot_primary_model_usable'] is False
        assert result['evidence']=={}


def test_unreadable_health_reports_no_evidence(tmp_path):
    config = tmp_path/'.config/whatsoup/instances/bot/config.json'
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({'healthPort':9090}))
    with patch.object(sys,'platform','darwin'):
        result=remote_probe(tmp_path, {'health':(503,{}),'ready':(200,{'status':'ready'})},instances=['bot'])
    assert result['evidence']=={}


def test_disabled_instance_is_reported_retired_and_never_probed(tmp_path):
    import plistlib
    instances = tmp_path/'.config/whatsoup/instances'
    agents = tmp_path/'Library/LaunchAgents'
    agents.mkdir(parents=True)
    for instance, port, extra in [('retired-i', 9101, {'enabled': False}), ('live-i', 9102, {}), ('dead-i', 9103, {'enabled': True})]:
        (instances/instance).mkdir(parents=True)
        (instances/instance/'config.json').write_text(json.dumps({'healthPort': port, **extra}))
        (instances/instance/'tokens.env').write_text('WHATSOUP_HEALTH_TOKEN=test\n')
        (agents/('com.whatsoup.'+instance+'.plist')).write_bytes(plistlib.dumps({'RunAtLoad': True, 'KeepAlive': True}))
    body = {'status':'healthy','whatsapp':{'connected':True},'runtime':{'agent':{'degradedReasons':['some_reason']}},'turn_capability':{'model_usable':True,'model_usable_stale':False,'model_usability_status':'usable'}}
    ports = []
    def respond(req, timeout):
        ports.append(int(req.full_url.split(':')[2].split('/')[0]))
        if ports[-1] == 9103:
            raise ConnectionRefusedError
        response = io.BytesIO(json.dumps(body).encode())
        response.status = 200
        return response
    def no_subprocess(*args, **kwargs):
        raise AssertionError('probe must not spawn processes in this test')
    request = {'instances': ['retired-i', 'live-i', 'dead-i'],'health_reader_code': HEALTH_READER.read_text()}
    output = io.StringIO()
    with patch.object(sys, 'argv', ['probe', json.dumps(request)]), patch.object(sys, 'platform', 'darwin'), patch('pathlib.Path.home', return_value=tmp_path), patch('urllib.request.urlopen', side_effect=respond), patch('subprocess.run', side_effect=no_subprocess), contextlib.redirect_stdout(output):
        exec(compile((ROOT/'fleet_probe_remote.py').read_text(), 'remote', 'exec'), {})
    result = json.loads(output.getvalue())
    checks = result['checks']
    assert checks['retired_i_retired'] is True
    for suffix in ('persistent', 'health_readable', 'whatsapp_connected', 'primary_model_usable'):
        assert 'retired_i_'+suffix not in checks
    assert not any(code.startswith('retired_i_') for code in result['codes'])
    assert 9101 not in ports
    # Positive control: an instance without the key is still fully checked.
    assert 'live_i_retired' not in checks
    assert checks['live_i_persistent'] is True
    assert checks['live_i_health_readable'] is True
    assert checks['live_i_whatsapp_connected'] is True
    assert checks['live_i_primary_model_usable'] is True
    assert 'live_i_some_reason' in result['codes']
    # Positive control: an enabled instance whose health is unreadable still fails.
    assert 'dead_i_retired' not in checks
    assert checks['dead_i_health_readable'] is False
    assert checks['dead_i_whatsapp_connected'] is None
    assert ports == [9102, 9103]


def test_probe_reports_the_exact_instances_it_was_asked_to_check(tmp_path):
    # A listed instance with no config is still listed; the observer infers a
    # removal only from this explicit list.
    result = remote_probe(tmp_path, {'health': (200, {'status': 'ok'}), 'ready': (200, {'status': 'ready'})}, instances=['sample-bot', 'secondary-bot'])
    assert result['instances'] == ['sample_bot', 'secondary_bot']
    assert result['checks']['sample_bot_configured'] is False
    empty = remote_probe(tmp_path, {'health': (200, {'status': 'ok'}), 'ready': (200, {'status': 'ready'})})
    assert empty['instances'] == []


def test_malformed_instance_config_crashes_the_probe_so_the_wrapper_reports_failure(tmp_path):
    import pytest
    config = tmp_path/'.config/whatsoup/instances/bad/config.json'
    config.parent.mkdir(parents=True)
    config.write_text('{not json')
    with pytest.raises(ValueError):
        remote_probe(tmp_path, {'health': (200, {'status': 'ok'}), 'ready': (200, {'status': 'ready'})}, instances=['bad'])
    failed = types.SimpleNamespace(returncode=1, stdout=b'')
    with patch('subprocess.run', return_value=failed):
        wrapper = adapter().run_target({'local': True})
    assert wrapper['checks'] == {'ssh_reachable': False}
    assert 'instances' not in wrapper


# A stand-in for the Microsoft 365 MCP plugin: it answers over stdio as the real
# server does and logs every request, so a test sees each tool the probe calls.
# Any tool without a scripted reply (a mail read, say) gets a successful one. A
# scripted reply supplies the JSON-RPC fields beside id: a result or an error.
FAKE_MCP = '''
import json,sys
log,scenario=sys.argv[1],json.loads(open(sys.argv[2]).read())
for line in sys.stdin:
    msg=json.loads(line)
    with open(log,'a') as f:f.write(line)
    if 'id' not in msg:continue
    if msg['method']=='initialize':reply={'result':{'protocolVersion':'2024-11-05','capabilities':{},'serverInfo':{'name':'fake','version':'1'}}}
    elif msg['method']=='tools/list':reply={'result':{'tools':[{'name':n} for n in scenario['tools']]}}
    else:reply=scenario['calls'].get(msg['params']['name'],{'result':{'content':[{'type':'text','text':'{"value":[{"id":"m1"}]}'}]}})
    print(json.dumps({'jsonrpc':'2.0','id':msg['id'],**reply}),flush=True)
'''
TOOLS = ['get-auth-status', 'get-diagnostics', 'list-mail-messages', 'get-mail-message', 'list-events', 'list-drive-children']
# Every JSON-RPC message a signed-in probe may send, in order: no other tool call.
SEQUENCE = ['initialize', 'notifications/initialized', 'tools/list', 'tools/call get-auth-status', 'tools/call get-diagnostics']


def reply(body, is_error=False):
    # One text block, as the plugin's jsonResult (pretty JSON) and errorResult ("[CODE] message", isError) build it.
    result = {'content': [{'type': 'text', 'text': body if isinstance(body, str) else json.dumps(body, indent=2)}]}
    if is_error:
        result['isError'] = True
    return {'result': result}


def diagnostics(connectivity):
    return reply({'authenticated': True, 'account': 'robot@synthetic.example', 'graphConnectivity': connectivity})


SIGNED_IN = reply({'authenticated': True, 'account': {'username': 'robot@synthetic.example'}})


def m365_probe(tmp_path, tools, calls, mcp_code=None, configured=('bot',), listed=()):
    """Run the m365 section against the fake plugin.

    Each configured instance resolves the same fake plugin; listed is the
    target's instance list. Return the probe output, every JSON-RPC message
    sent (a tools/call with its tool name), and the commands run after the
    calls (the lsof that follows them).
    """
    server, log, scenario = tmp_path/'fake_mcp.py', tmp_path/'requests.jsonl', tmp_path/'scenario.json'
    server.write_text(FAKE_MCP)
    scenario.write_text(json.dumps({'tools': tools, 'calls': calls}))
    for name in configured:
        instance = tmp_path/'.config/whatsoup/instances'/name
        instance.mkdir(parents=True)
        (instance/'config.json').write_text(json.dumps({'agentOptions': {}}))
        (instance/'agent365.mcp.json').write_text(json.dumps({'mcpServers': {'microsoft_365': {'command': sys.executable, 'args': [str(server), str(log), str(scenario)]}}}))
    request = {
        'instances': list(listed), 'm365': True, 'expected_email': 'robot@synthetic.example',
        'mcp_code': mcp_code or (ROOT/'mcp_probe_remote.py').read_text(),
        'health_reader_code': HEALTH_READER.read_text(),
    }
    ran = []
    def run_command(command, **kwargs):
        ran.append(command[0])
        return types.SimpleNamespace(returncode=0, stdout='')
    output = io.StringIO()
    # A listed instance's health read finds no bot listening.
    with patch.object(sys, 'argv', ['probe', json.dumps(request)]), patch.object(sys, 'platform', 'darwin'), patch('pathlib.Path.home', return_value=tmp_path), patch('subprocess.run', side_effect=run_command), patch('urllib.request.urlopen', side_effect=ConnectionRefusedError), contextlib.redirect_stdout(output):
        exec(compile((ROOT/'fleet_probe_remote.py').read_text(), 'remote', 'exec'), {})
    sent = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    sent = [m['method'] + (' ' + m['params']['name'] if m['method'] == 'tools/call' else '') for m in sent]
    return json.loads(output.getvalue()), sent, ran


def test_m365_check_reads_no_mailbox_and_reports_graph_reachable(tmp_path):
    result, sent, ran = m365_probe(tmp_path, TOOLS, {'get-auth-status': SIGNED_IN, 'get-diagnostics': diagnostics({'ok': True, 'latencyMs': 41})})
    # The plugin offers mail, calendar and files tools; the probe calls none of them.
    assert sent == SEQUENCE
    assert ran == ['/usr/sbin/lsof']
    checks = result['checks']
    assert checks['m365_graph_reachable'] is True
    assert 'm365_mail_read' not in checks
    assert checks['m365_mcp_available'] is True
    assert checks['m365_authenticated'] is True
    assert checks['m365_identity'] is True
    assert result['codes'] == []


# Plugin messages for an expired token (src/auth/auth-service.ts:224, surfacing
# through src/graph/client.ts:79; src/graph/error-normalizer.ts:48 for a 401).
# get-diagnostics reports them bare in graphConnectivity.error, with no [AUTH_EXPIRED].
REFRESH_FAILED = 'Token refresh failed. Please re-authenticate using the login tool.'
EXPIRED = 'Authentication expired. Please re-authenticate using the login tool.'


@pytest.mark.parametrize('answer, codes', [
    (diagnostics({'ok': False, 'latencyMs': 212, 'error': REFRESH_FAILED}), ['auth_expired']),
    (diagnostics({'ok': False, 'latencyMs': 95, 'error': EXPIRED}), ['auth_expired']),
    (reply({'graphConnectivity': {'ok': False, 'error': EXPIRED}, 'detail': '[AUTH_EXPIRED] token'}), ['auth_expired']),
    # Only the two whole plugin messages count; other text that merely starts the same way does not.
    (diagnostics({'ok': False, 'error': 'Authentication expired warning configuration is invalid'}), []),
    (diagnostics({'ok': False, 'error': 'Token refresh failed: connect ETIMEDOUT'}), ['etimedout']),
    (reply('[AUTH_EXPIRED] ' + REFRESH_FAILED, is_error=True), ['auth_expired']),
    ({'error': {'code': -32603, 'message': 'invalid_grant: AADSTS700082'}}, ['aadsts700082', 'invalid_grant']),
    (reply('not json'), []),
    (diagnostics({'ok': 1}), []),
    (diagnostics({'ok': 'true'}), []),
    (reply({'authenticated': True}), []),
    (diagnostics('ok'), []),
    (reply({'graphConnectivity': {'ok': True}}, is_error=True), []),
    ({'result': None}, []),
    ({'result': [{'type': 'text', 'text': '{"graphConnectivity": {"ok": true}}'}]}, []),
], ids=[
    'token-refresh-failed', 'graph-401', 'both-auth-rules', 'prefix-only-expired', 'prefix-only-refresh', 'tool-error', 'jsonrpc-error', 'unparseable',
    'ok-one', 'ok-string', 'no-connectivity', 'connectivity-not-dict', 'is-error-ok-true', 'result-null', 'result-list',
])
def test_failed_graph_call_reports_unreachable_with_its_codes(tmp_path, answer, codes):
    result, sent, ran = m365_probe(tmp_path, TOOLS, {'get-auth-status': SIGNED_IN, 'get-diagnostics': answer})
    assert sent == SEQUENCE
    # The reply was handled without raising: the probe went on to its lsof read.
    assert ran == ['/usr/sbin/lsof']
    assert result['checks']['m365_graph_reachable'] is False
    assert result['codes'] == codes


@pytest.mark.parametrize('tools, auth', [
    ([t for t in TOOLS if t != 'get-diagnostics'], SIGNED_IN),
    (TOOLS, reply({'authenticated': False})),
], ids=['no-diagnostics-tool', 'signed-out'])
def test_graph_check_runs_only_when_signed_in_with_the_diagnostics_tool(tmp_path, tools, auth):
    result, sent, ran = m365_probe(tmp_path, tools, {'get-auth-status': auth, 'get-diagnostics': diagnostics({'ok': True})})
    assert sent == SEQUENCE[:4]
    # As the mail check did, a check that could not run reads as not passed.
    assert result['checks']['m365_graph_reachable'] is False
    assert result['codes'] == []


def test_crashed_m365_probe_reports_the_graph_check_unknown(tmp_path):
    result, sent, ran = m365_probe(tmp_path, TOOLS, {}, mcp_code='raise RuntimeError("probe crashed")')
    assert sent == []
    assert result['checks']['m365_graph_reachable'] is None
    assert 'm365_mail_read' not in result['checks']
    assert 'mcp_probe_incomplete' in result['codes']


M365_CHECKS = ('m365_mcp_available', 'm365_authenticated', 'm365_graph_reachable', 'm365_identity')
SIGNED_IN_CALLS = {'get-auth-status': SIGNED_IN, 'get-diagnostics': diagnostics({'ok': True})}


# node-b runs gamma-bot (its target's only instance) and secondary-bot, and both
# resolve the user plugin. The m365 checks need exactly one probe row.
def test_m365_probe_reads_only_the_targets_listed_instances(tmp_path):
    result, sent, ran = m365_probe(tmp_path, TOOLS, SIGNED_IN_CALLS, configured=('gamma-bot', 'secondary-bot'), listed=('gamma-bot',))
    assert sent == SEQUENCE
    assert ran == ['/usr/sbin/lsof']
    assert {c: result['checks'][c] for c in M365_CHECKS} == dict.fromkeys(M365_CHECKS, True)
    assert result['codes'] == []


@pytest.mark.parametrize('configured', [('alpha-bot', 'personal'), ('alpha-bot',)], ids=['personal-configured', 'personal-missing'])
def test_a_listed_personal_instance_is_still_skipped(tmp_path, configured):
    # As on node-a and node-l: "personal" is listed but never runs the plugin,
    # so a missing personal config is no m365 finding either.
    result, sent, ran = m365_probe(tmp_path, TOOLS, SIGNED_IN_CALLS, configured=configured, listed=('alpha-bot', 'personal'))
    assert sent == SEQUENCE
    assert {c: result['checks'][c] for c in M365_CHECKS} == dict.fromkeys(M365_CHECKS, True)
    assert result['codes'] == []


def test_without_a_list_every_instance_is_probed_as_today(tmp_path):
    # Today's behaviour, kept for callers that send no instance list: two
    # rows, so every m365 check reads False with no code.
    result, sent, ran = m365_probe(tmp_path, TOOLS, SIGNED_IN_CALLS, configured=('gamma-bot', 'secondary-bot'))
    assert sent == SEQUENCE + SEQUENCE
    assert ran == ['/usr/sbin/lsof', '/usr/sbin/lsof']
    assert {c: result['checks'][c] for c in M365_CHECKS} == dict.fromkeys(M365_CHECKS, False)
    assert result['codes'] == []


def test_a_listed_instance_without_config_reads_false_and_is_coded(tmp_path):
    result, sent, ran = m365_probe(tmp_path, TOOLS, SIGNED_IN_CALLS, configured=('secondary-bot',), listed=('gamma-bot',))
    assert sent == []
    assert ran == []
    assert {c: result['checks'][c] for c in M365_CHECKS} == dict.fromkeys(M365_CHECKS, False)
    assert result['codes'] == ['m365_instance_not_found']
