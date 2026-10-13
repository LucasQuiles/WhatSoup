import contextlib,datetime,io,json,os,pathlib,plistlib,re,shlex,subprocess,sys,time,urllib.request,urllib.error

request=json.loads(sys.argv[1]);r=pathlib.Path.home()
checks={'ssh_reachable':True};codes=[]
# Per check, a stamp of the evidence behind its result; see the observer's validate_probe.
evidence={}
health_reader={}
exec(compile(request['health_reader_code'],'health_reader','exec'),health_reader)
# Checks the owner retired for this host, named in its target: the observer forgets them and clears what they opened.
# Only names the observer accepts as check names pass; anything else is dropped and coded.
if 'retired_checks' in request:
    names=request['retired_checks'] if isinstance(request['retired_checks'],list) else None
    retired_checks=[n for n in names or [] if isinstance(n,str) and re.fullmatch('[a-z0-9][a-z0-9_-]{0,79}',n)]
    if names is None or len(retired_checks)!=len(names):codes.append('retired_check_name_invalid')

def http(port,path,token=None):
    try:
        req=urllib.request.Request('http://127.0.0.1:%d%s'%(port,path),headers={'Authorization':'Bearer '+token} if token else {})
        try:response=urllib.request.urlopen(req,timeout=5)
        except urllib.error.HTTPError as e:response=e
        payload=response.read(1000000)
        return response.status,json.loads(payload)
    except Exception:return None,{}

def env_file(path):
    values={}
    if path.exists():
        for line in path.read_text().splitlines():
            fields=shlex.split(line)
            if fields and '=' in fields[-1]:
                key,value=fields[-1].split('=',1);values[key]=value
    return values

instances=request.get('instances',[])
if request.get('expect_no_bot'):
    checks['no_unexpected_bot']=not any((r/'.config/whatsoup/instances').glob('*/config.json'))
for instance in instances:
    cfgpath=r/'.config/whatsoup/instances'/instance/'config.json'
    name=instance.replace('-','_')
    checks[name+'_configured']=cfgpath.is_file()
    if not cfgpath.is_file():continue
    cfg=json.loads(cfgpath.read_text())
    # An owner-retired instance has nothing listening; report it rather than probe it.
    if cfg.get('enabled') is False:
        checks[name+'_retired']=True;continue
    token=health_reader['instance_health_token'](instance)
    plist=r/'Library/LaunchAgents'/('com.whatsoup.'+instance+'.plist')
    if plist.exists():
        data=plistlib.loads(plist.read_bytes())
        if not token:token=data.get('EnvironmentVariables',{}).get('WHATSOUP_HEALTH_TOKEN')
        persistent=data.get('RunAtLoad') is True and bool(data.get('KeepAlive'))
        watchdog=r/'Library/LaunchAgents'/('com.whatsoup.'+instance+'-watchdog.plist')
        if not persistent and watchdog.exists():
            wd=plistlib.loads(watchdog.read_bytes())
            active=subprocess.run(['/bin/launchctl','print','gui/%s/%s'%(os.getuid(),wd['Label'])],capture_output=True,timeout=5)
            persistent=active.returncode==0 and wd.get('RunAtLoad') is True and 0<wd.get('StartInterval',0)<=300
        checks[name+'_persistent']=persistent
    elif sys.platform=='linux':
        unit=subprocess.run(['systemctl','--user','show','whatsoup@'+instance+'.service','-p','UnitFileState','-p','Restart','-p','ActiveState'],capture_output=True,text=True,timeout=5)
        values=dict(line.split('=',1) for line in unit.stdout.splitlines() if '=' in line)
        checks[name+'_persistent']=unit.returncode==0 and values.get('UnitFileState')=='enabled' and values.get('Restart') in ('always','on-failure') and values.get('ActiveState')=='active'
    status,health=http(cfg.get('healthPort',0),'/health',token)
    disclosed=health_reader['classify_projection'](health,token_sent=bool(token))=='diagnostic'
    checks[name+'_health_readable']=disclosed
    checks[name+'_whatsapp_connected']=health.get('whatsapp',{}).get('connected') if disclosed else None
    if disclosed:
        if isinstance(health.get('runtime',{}).get('agent'),dict):
            capability=health.get('turn_capability') or {}
            usable=capability.get('model_usable')
            checks[name+'_primary_model_usable']=usable if type(usable) is bool and capability.get('model_usable_stale') is False else None
            # The bot re-probes its model every 30 min (up to 2 h after failures); its own check time tells one probe result read twice from a new one.
            # Epoch-ms stamps are below 1e13; the bound also drops NaN, infinities and integers too large for the wrapper's JSON parse.
            # Only bots that report model_usable_freshness_ms (WhatSoup #3325) keep a failed result fresh until their next probe;
            # an older bot's result turns stale first, so it gets no stamp and keeps the per-read count.
            stamp=capability.get('model_usable_checked_at')
            window=capability.get('model_usable_freshness_ms')
            if type(stamp) in (int,float) and abs(stamp)<1e16 and type(window) in (int,float):evidence[name+'_primary_model_usable']=stamp
            reason=capability.get('model_usability_status')
            if usable is False and isinstance(reason,str) and re.fullmatch('[a-z-]+',reason):codes.append(name+'_primary_model_'+reason.replace('-','_'))
        reasons=health.get('runtime',{}).get('agent',{}).get('degradedReasons',[])
        for reason in reasons:
            if re.fullmatch('[a-z_]+',reason):codes.append(name+'_'+reason)

broker=request.get('broker')
if broker:
    token=None
    plist=r/'Library/LaunchAgents/com.agent365.service.plist'
    if plist.exists():
        d=plistlib.loads(plist.read_bytes());args=d['ProgramArguments'];v={a:args[i+1] for i,a in enumerate(args[:-1]) if a.startswith('--')}
        token=env_file(pathlib.Path(v['--env-file'])).get('AGENT365_API_KEY')
        checks['broker_persistent']=d.get('RunAtLoad') is True and bool(d.get('KeepAlive'))
        loaded=subprocess.run(['/bin/launchctl','print','gui/%s/%s'%(os.getuid(),d['Label'])],capture_output=True,timeout=5)
        checks['broker_loaded']=loaded.returncode==0
    else:
        token=env_file(r/'LAB/Agent365/.env').get('AGENT365_API_KEY')
    status,live=http(10000,'/health' if broker=='legacy' else '/live',token)
    if broker=='legacy':
        checks['broker_http_responsive']=status in (200,503) and isinstance(live.get('status'),str)
        checks['broker_legacy_health']=status==200 and live.get('status') in ('ok','healthy')
    else:checks['broker_liveness']=status==200 and live.get('status') in ('ok','healthy')
    status,ready=http(10000,'/ready',token)
    checks['broker_ready']=None if status==404 else status==200 and ready.get('status') in ('ready','ok','healthy')
    if status==404:codes.append('broker_readiness_endpoint_unsupported')
    for reason in ready.get('reason_codes',[]):
        if re.fullmatch('[a-z_]+',reason):codes.append(reason)

if request.get('warmer'):
    p=r/'LAB/Agent365/data/warmer/state.json'
    try:
        w=json.loads(p.read_text());updated=datetime.datetime.fromisoformat(w['updated_at']).timestamp()
        checks['legacy_warmer_fresh']=0<=time.time()-updated<=7200
        accounts=list(w.get('accounts',{}).values())
        checks['legacy_warmer_authenticated']=bool(accounts) and all(a.get('fail_streak')==0 for a in accounts) if checks['legacy_warmer_fresh'] else None
        if any(any(code in a.get('last_fail_reason','') for code in ['invalid_grant','700082','AUTH_EXPIRED']) for a in accounts):codes.append('legacy_warmer_reauthentication_required')
    except Exception:checks.update(legacy_warmer_fresh=False,legacy_warmer_authenticated=None)

if request.get('m365'):
    output=io.StringIO()
    # The checks need exactly one probe row, so only the target's listed instances run the plugin probe (a host may run multiple bots).
    # The plugin probe never reads "personal"; any other listed instance without a config is coded.
    scope={'__name__':'__main__'}
    if instances:scope['WANTED_INSTANCES']=instances
    if any(i!='personal' and not (r/'.config/whatsoup/instances'/i/'config.json').is_file() for i in instances):codes.append('m365_instance_not_found')
    try:
        with contextlib.redirect_stdout(output):exec(compile(request['mcp_code'],'mcp_read_probe','exec'),scope)
        payload=json.loads(output.getvalue());probes=payload.get('probes',[])
        expected=request.get('expected_email')
        checks['m365_mcp_available']=len(probes)==1 and probes[0].get('tool_count',0)>0
        checks['m365_authenticated']=len(probes)==1 and probes[0].get('auth',{}).get('authenticated') is True
        checks['m365_graph_reachable']=len(probes)==1 and probes[0].get('graph_reachable') is True
        checks['m365_identity']=len(probes)==1 and str(probes[0].get('account_username','')).casefold()==expected.casefold() if expected else None
        for probe in probes:
            for code in probe.get('graph_error_codes',[]):
                code=code.lower()
                if re.fullmatch('[a-z0-9_]+',code):codes.append(code)
    except Exception:
        checks.update(m365_mcp_available=False,m365_authenticated=None,m365_graph_reachable=None,m365_identity=None)
        codes.append('mcp_probe_incomplete')

if request.get('central'):
    for name,limit in [('dispatcher-state.json',180),('collector-state.json',180),('heartbeat-watchdog-state.json',660)]:
        path=r/'.local/state/bot-errors'/name
        checks[name.split('-state')[0].replace('-','_')+'_heartbeat']=path.exists() and 0<=time.time()-path.stat().st_mtime<=limit

if request.get('isolated_canary'):
    values=env_file(r/'.config/agent365-canary/service.env')
    status,live=http(11000,'/live',values.get('AGENT365_API_KEY'))
    checks['isolated_canary_liveness']=status==200 and live.get('status')=='ok'

# The exact instance list lets the observer tell a removed instance from a failed probe.
output={'checked_at':time.time(),'checks':checks,'codes':codes[:32],'instances':[i.replace('-','_') for i in instances],'evidence':evidence}
if 'retired_checks' in request:output['retired_checks']=retired_checks
print(json.dumps(output))
