import json,os,pathlib,plistlib,re,selectors,signal,subprocess,time
r=pathlib.Path.home();out={'checked_at':time.time(),'probes':[]}
for path in (r/'.config/whatsoup/instances').glob('*/config.json'):
 instance=path.parent.name
 if instance=='personal':continue
 # A caller that names its instances gets rows for those alone: a host may run a second, unlisted bot.
 if 'WANTED_INSTANCES' in globals() and instance not in WANTED_INSTANCES:continue
 cfg=json.loads(path.read_text());options=cfg.get('agentOptions',{})
 plist=r/'Library/LaunchAgents'/('com.whatsoup.'+instance+'.plist')
 env=os.environ.copy()
 if plist.exists():env.update(plistlib.loads(plist.read_bytes()).get('EnvironmentVariables',{}))
 dirs=[pathlib.Path(p) for p in options.get('pluginDirs',[]) if '365' in p]
 explicit=path.parent/'agent365.mcp.json'
 explicit_servers=json.loads(explicit.read_text()).get('mcpServers') if explicit.exists() else None
 if explicit_servers:
  launcher=explicit_servers['microsoft_365']['args'][0]
  dirs=[pathlib.Path(launcher).parent.parent]
 if not dirs:dirs=[r/'.claude/plugins/microsoft-365']
 for plugin in dirs:
  manifest=plugin/'.claude-plugin/plugin.json'
  if not manifest.exists() and not explicit_servers:continue
  servers=explicit_servers or json.loads(manifest.read_text()).get('mcpServers',{})
  if not isinstance(servers,dict):continue
  for name,server in servers.items():
   if '365' not in name:continue
   row={'instance':instance,'plugin':str(plugin),'mcp_name':name};out['probes'].append(row)
   env['CLAUDE_PLUGIN_ROOT']=str(plugin)
   env['CLAUDE_PLUGIN_DATA']=str(r/'.claude/plugins/data/microsoft_365-microsoft-365-dev')
   def expand(v):return v.replace('${CLAUDE_PLUGIN_ROOT}',str(plugin)).replace('${CLAUDE_PLUGIN_DATA}',env['CLAUDE_PLUGIN_DATA'])
   env.update({k:expand(v) for k,v in server.get('env',{}).items()})
   command=expand(server['command']);args=[expand(v) for v in server.get('args',[])]
   if command=='node':
    candidates=[env.get('WHATSOUP_NODE',''),str(r/'.nvm/versions/node/v24.15.0/bin/node'),'/opt/homebrew/bin/node']
    command=next((p for p in candidates if p and pathlib.Path(p).is_file()),command)
   row['configured_command']=command;row['artifact_exists']=all(pathlib.Path(a).exists() for a in args if a.startswith('/') and not a.startswith('//'))
   try:
    proc=subprocess.Popen([command]+args,env=env,cwd=options.get('cwd') or str(r),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    selector=selectors.DefaultSelector();selector.register(proc.stdout,selectors.EVENT_READ);pending=bytearray()
    def request(n,method,params=None):
     msg={'jsonrpc':'2.0','method':method}
     if n is not None:msg['id']=n
     if params is not None:msg['params']=params
     proc.stdin.write((json.dumps(msg)+'\n').encode());proc.stdin.flush()
     if n is None:return
     deadline=time.monotonic()+30
     while time.monotonic()<deadline:
      while b'\n' in pending:
       line,_,rest=pending.partition(b'\n');pending[:]=rest
       try:answer=json.loads(line)
       except Exception:continue
       if answer.get('id')==n:return answer
      if selector.select(timeout=0.5):
       chunk=os.read(proc.stdout.fileno(),65536)
       if not chunk:raise RuntimeError('mcp_closed')
       pending.extend(chunk)
       if len(pending)>1000000:raise RuntimeError('mcp_output_limit')
     raise RuntimeError('mcp_deadline')
    try:
     init=request(1,'initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'fleet-read-verifier','version':'1'}})
     request(None,'notifications/initialized')
     listing=request(2,'tools/list');names={t['name'] for t in listing.get('result',{}).get('tools',[])}
     row['tool_count']=len(names);row['durable_mail_tools']={'get-mail-operation','cancel-mail-operation'}<=names
     auth_name=next((n for n in ['get-auth-status','auth-status'] if n in names),None)
     row['auth_tool']=auth_name
     if auth_name:
      ans=request(3,'tools/call',{'name':auth_name,'arguments':{}});result=ans.get('result',{})
      body=''.join(c['text'] for c in result.get('content',[]) if c.get('type')=='text')
      try:
       d=json.loads(body);row['auth']={k:d[k] for k in ['authenticated','scopeStatus','message','error','mode'] if k in d}
       row['auth_keys']=list(d);row['account_username']=d.get('account',{}).get('username')
      except Exception:row['auth_parse']='unrecognized'
      row['mcp_error']=bool(ans.get('error') or result.get('isError'))
     # get-diagnostics makes one GET /me?$select=id: it proves the token works without reading any mailbox.
     if 'get-diagnostics' in names and row.get('auth',{}).get('authenticated') is True:
      ans=request(4,'tools/call',{'name':'get-diagnostics','arguments':{}})
      res=ans.get('result');res=res if isinstance(res,dict) else {}
      try:d=json.loads(''.join(c['text'] for c in res.get('content',[]) if c.get('type')=='text'))
      except Exception:d={}
      conn=d.get('graphConnectivity') if isinstance(d,dict) else None;conn=conn if isinstance(conn,dict) else {}
      row['graph_reachable']=not (ans.get('error') or res.get('isError')) and conn.get('ok') is True
      if not row['graph_reachable']:
       body=json.dumps(ans)
       row['graph_error_codes']=sorted(set(re.findall(r'AADSTS\d+|InvalidAuthenticationToken|MailboxNotEnabledForRESTAPI|ErrorAccessDenied|invalid_grant|interaction_required|consent_required|AuthenticationError|ECONNREFUSED|ETIMEDOUT',body)))
       row['graph_error_codes']+=['AUTH_EXPIRED'] if '[AUTH_EXPIRED]' in body else []
       # get-diagnostics reports the plugin's expired-token message bare, without the [AUTH_EXPIRED] that errorResult adds.
       if conn.get('error') in ('Token refresh failed. Please re-authenticate using the login tool.','Authentication expired. Please re-authenticate using the login tool.') and 'AUTH_EXPIRED' not in row['graph_error_codes']:row['graph_error_codes'].append('AUTH_EXPIRED')
     opened=subprocess.run(['/usr/sbin/lsof','-a','-p',str(proc.pid),'-d','txt','-Fn'],capture_output=True,text=True,timeout=5)
     row['observed_executable_paths']=[v[1:] for v in opened.stdout.splitlines() if v.startswith('n') and ('/node' in v or '/python' in v)]
    finally:
     selector.close()
     if proc.poll() is None:
      os.killpg(proc.pid,signal.SIGTERM)
      try:proc.wait(timeout=3)
      except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
     err=proc.stderr.read(16384).decode(errors='replace')
     row['process_exit']=proc.returncode
     row['stderr_bytes']=len(err)
     if proc.returncode not in (0,-15):
      for k,v in env.items():
       if len(v)>8 and any(w in k.upper() for w in ['KEY','TOKEN','SECRET']):err=err.replace(v,'[redacted]')
      row['startup_error_excerpt']=re.sub(r'[A-Za-z0-9_+=/.-]{40,}','[redacted]',err)[:1500]
     row['startup_error_codes']=sorted(set(re.findall(r'MS365_[A-Z0-9_]+|AGENT365_[A-Z0-9_]+|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ENOENT|keychain[^\n]{0,100}|Keychain[^\n]{0,100}|API key[^\n]{0,100}|bridge is not ready:[^\n]{0,180}|Error:[^\n]{0,180}',err)))
   except Exception as e:row['error']=str(e) if isinstance(e,RuntimeError) else type(e).__name__
print(json.dumps(out))
