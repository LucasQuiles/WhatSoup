"""Daily-card recovery across legacy and controller-backed state publication."""
from contextlib import contextmanager

import pytest

import test_bot_errors_info_volume as support

mod = support.mod
pinned_clock = support.pinned_clock
_clean_env = support._clean_env


@contextmanager
def daily_cycle(mod, adopted):
    if not adopted:
        yield None
        return
    with mod.open_dispatcher_state_session() as session:
        loaded = session.load()
        yield mod.IncidentStateCycle(session, loaded.payload, loaded.capability, paths=mod.state_paths())


@pytest.fixture(params=[False, True], ids=['compat', 'adopted'])
def daily_case(mod, request, pinned_clock):
    support._write_state(mod, {
        'hub-1|logged-line|instance_logged_out': support._physical(support.OLD - 86400, support.OLD),
    })
    support._defer_info_notice(mod, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    adopted = request.param
    if adopted:
        seed = mod.load_incident_state(mod.state_paths())
        with daily_cycle(mod, True) as cycle:
            cycle.payload.clear()
            cycle.payload.update(seed)
            cycle.commit()
    return adopted


def invoke_daily(mod, adopted, card, now):
    send = mod.send_daily_information_summary if card == 'informationSummary' else mod.send_daily_line_card
    with daily_cycle(mod, adopted) as cycle:
        return send(mod.state_paths(), incident=cycle, now=now)


def persisted_section(mod, adopted, card):
    with daily_cycle(mod, adopted) as cycle:
        payload = cycle.payload if cycle else mod.load_incident_state(mod.state_paths())
        return dict(payload[card])


@pytest.mark.parametrize('card', ['informationSummary', 'lineCheckCard'])
def test_accepted_daily_send_survives_process_loss_before_state_commit(mod, monkeypatch, daily_case, card):
    tries = support._rpc_replies(mod, monkeypatch, [support.ACCEPTED, support.ACCEPTED])
    real_send = mod.send_notice_text

    def accepted_then_exit(text):
        assert real_send(text) is True
        raise SystemExit(73)

    monkeypatch.setattr(mod, 'send_notice_text', accepted_then_exit)
    with pytest.raises(SystemExit, match='73'):
        invoke_daily(mod, daily_case, card, support.NOW)
    monkeypatch.setattr(mod, 'send_notice_text', real_send)
    assert invoke_daily(mod, daily_case, card, support.NOW + mod.DAILY_CARD_RETRY_SECONDS) == 0
    assert len(tries) == 1
    section = persisted_section(mod, daily_case, card)
    assert section['lastSendUnconfirmed'] is True
    assert section['lastSentDay'] == support.DAY
    assert mod.read_notice_packet(mod.state_paths(), section['lastRef'])
    if card == 'informationSummary':
        assert section['pending'] == []


@pytest.mark.parametrize('card', ['informationSummary', 'lineCheckCard'])
def test_accepted_daily_send_survives_final_state_publication_failure(mod, monkeypatch, daily_case, card):
    tries = support._rpc_replies(mod, monkeypatch, [support.ACCEPTED, support.ACCEPTED])
    commit = mod._commit_incident_state

    def fail_after_send(*args):
        if tries:
            raise OSError('publication failed after accepted send')
        return commit(*args)

    monkeypatch.setattr(mod, '_commit_incident_state', fail_after_send)
    with pytest.raises(OSError, match='publication failed after accepted send'):
        invoke_daily(mod, daily_case, card, support.NOW)
    monkeypatch.setattr(mod, '_commit_incident_state', commit)
    assert invoke_daily(mod, daily_case, card, support.NOW + mod.DAILY_CARD_RETRY_SECONDS) == 0
    assert len(tries) == 1
    assert persisted_section(mod, daily_case, card)['lastSendUnconfirmed'] is True


@pytest.mark.parametrize('card', ['informationSummary', 'lineCheckCard'])
def test_daily_send_requires_durable_intent_before_network_call(mod, monkeypatch, daily_case, card):
    tries = support._rpc_replies(mod, monkeypatch, [support.ACCEPTED, support.ACCEPTED])
    commit = mod._commit_incident_state

    def failed_commit(*_args):
        raise OSError('cannot publish intent')

    monkeypatch.setattr(mod, '_commit_incident_state', failed_commit)
    with pytest.raises(OSError, match='cannot publish intent'):
        invoke_daily(mod, daily_case, card, support.NOW)
    assert tries == []
    monkeypatch.setattr(mod, '_commit_incident_state', commit)
    assert invoke_daily(mod, daily_case, card, support.NOW) == 1
    assert len(tries) == 1


@pytest.mark.parametrize('card', ['informationSummary', 'lineCheckCard'])
def test_known_daily_rejection_restores_retryable_state(mod, monkeypatch, daily_case, card):
    tries = support._rpc_replies(mod, monkeypatch, [{'sent': False}, support.ACCEPTED])
    assert invoke_daily(mod, daily_case, card, support.NOW) == 0
    section = persisted_section(mod, daily_case, card)
    assert 'lastSentDay' not in section
    if card == 'informationSummary':
        assert [entry['noticeId'] for entry in section['pending']] == ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
    assert invoke_daily(mod, daily_case, card, support.NOW + mod.DAILY_CARD_RETRY_SECONDS) == 1
    assert len(tries) == 2
    assert persisted_section(mod, daily_case, card)['lastSendUnconfirmed'] is False


@pytest.mark.parametrize('reply,expected', [
    ({}, 'sent_unconfirmed'),
    ({'sent': False}, 'failed'),
    (support.ACCEPTED, 'sent'),
])
def test_meta_delivery_classification_survives_durable_logging(mod, monkeypatch, reply, expected):
    tries = support._rpc_replies(mod, monkeypatch, [reply])
    monkeypatch.setattr(mod, 'email_fallback', lambda *_a, **_k: False)
    paths = mod.state_paths()
    poisoned = paths['processing'] / 'synthetic-invalid.json'
    poisoned.write_text('{invalid')
    mod.quarantine_poison(poisoned, paths['quarantine'], 'invalid_json')
    records = support.dispatcher_fixtures.dispatch_log_records(paths)
    record = next(record for record in records if record['recordKind'] == 'quarantine')
    assert len(tries) == 1
    assert record['details']['directWhatsapp'] == expected


def block_packets(mod):
    packets = mod.state_paths()['packets']
    backup = packets.with_name('retained-packets')
    if packets.exists():
        packets.rename(backup)
    packets.write_text('synthetic packet storage failure')
    return packets, backup


def restore_packets(blocked):
    packets, backup = blocked
    packets.unlink()
    if backup.exists():
        backup.rename(packets)


@pytest.mark.parametrize('card', ['informationSummary', 'lineCheckCard'])
def test_daily_card_packet_failure_preserves_same_day_retry(mod, monkeypatch, daily_case, card):
    tries = support._rpc_replies(mod, monkeypatch, [support.ACCEPTED, support.ACCEPTED])
    blocked = block_packets(mod)
    assert invoke_daily(mod, daily_case, card, support.NOW) == 0
    assert tries == []
    section = persisted_section(mod, daily_case, card)
    assert 'lastSentDay' not in section
    assert section['lastAttemptAt'] == support.NOW
    if card == 'informationSummary':
        assert [entry['noticeId'] for entry in section['pending']] == ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']
    restore_packets(blocked)
    assert invoke_daily(mod, daily_case, card, support.NOW + 60) == 0
    assert invoke_daily(mod, daily_case, card, support.NOW + mod.DAILY_CARD_RETRY_SECONDS) == 1
    assert len(tries) == 1
    section = persisted_section(mod, daily_case, card)
    assert section['lastSentDay'] == support.DAY
    assert mod.read_notice_packet(mod.state_paths(), section['lastRef'])


@pytest.mark.parametrize('adopted', [False, True], ids=['compat', 'adopted'])
def test_daily_retirement_packet_failure_is_retried_by_the_next_stale_sweep(mod, monkeypatch, pinned_clock, adopted):
    key = 'host-2|retired-line|whatsapp_device_bond_lost'
    support._write_state(mod, {key: support._physical(support.OLD - 86400, support.OLD)})
    if adopted:
        seed = mod.load_incident_state(mod.state_paths())
        with daily_cycle(mod, True) as cycle:
            cycle.payload.clear()
            cycle.payload.update(seed)
            cycle.commit()
    tries = support._rpc_replies(mod, monkeypatch, [support.ACCEPTED])
    blocked = block_packets(mod)
    assert invoke_daily(mod, adopted, 'lineCheckCard', support.NOW) == 0
    with daily_cycle(mod, adopted) as cycle:
        state = cycle.payload if cycle else mod.load_incident_state(mod.state_paths())
        assert key in state['openIncidents']
        assert key not in state.get('lineRecheckRetired', {})
    restore_packets(blocked)
    with daily_cycle(mod, adopted) as cycle:
        assert mod.sweep_stale_incidents(mod.state_paths(), incident=cycle) == (0, 0, None)
    with daily_cycle(mod, adopted) as cycle:
        state = cycle.payload if cycle else mod.load_incident_state(mod.state_paths())
        assert key not in state['openIncidents']
        ref = state['lineRecheckRetired'][key]['ref']
        assert mod.read_notice_packet(mod.state_paths(), ref)['incidentKey'] == key
    assert tries == []
