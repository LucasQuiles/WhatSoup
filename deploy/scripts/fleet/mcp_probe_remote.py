import json,os,pathlib,plistlib,re,selectors,signal,struct,subprocess,sys,time

# Keep the group leader alive until cleanup, without hiding the server's PID or status.
# Unlike the batch command guard, MCP must retain the server for executable inspection.
_MCP_GUARD = r"""
import errno,os,select,signal,struct,subprocess,sys,time
owner,result=int(sys.argv[1]),int(sys.argv[2])
os.set_inheritable(owner,False)
os.set_inheritable(result,False)
signal.signal(signal.SIGTERM,lambda *_:None)
try:
 if select.select([owner],[],[],0)[0]:raise SystemExit(1)
 try:process=subprocess.Popen(sys.argv[3:],close_fds=True)
 except OSError as exc:
  os.write(result,struct.pack('!bi',1,exc.errno or errno.EIO))
  for fd in (0,1,2):os.close(fd)
  os.read(owner,1)
  raise SystemExit(1)
 os.write(result,struct.pack('!bi',2,process.pid))
 for fd in (0,1,2):os.close(fd)
 deadline=None
 while True:
  if select.select([owner],[],[],.02 if deadline is not None else None)[0]:
   if os.read(owner,1)!=b'F' or deadline is not None:break
   deadline=time.monotonic()+3
  if deadline is not None:
   code=process.poll()
   if code is None and time.monotonic()>=deadline:
    process.kill()
    code=process.wait(timeout=1)
   if code is not None:
    os.write(result,struct.pack('!bi',0,code))
    os.close(result)
    deadline=None
finally:
 os.killpg(os.getpgrp(),signal.SIGKILL)
"""

def read_status(fd,deadline):
 data=bytearray()
 os.set_blocking(fd,False)
 with selectors.DefaultSelector() as ready:
  ready.register(fd,selectors.EVENT_READ)
  while len(data)<5:
   if not ready.select(max(0,deadline-time.monotonic())):raise RuntimeError('process_status_deadline')
   try:chunk=os.read(fd,5-len(data))
   except BlockingIOError:continue
   if not chunk:raise RuntimeError('process_status_incomplete')
   data.extend(chunk)
 return struct.unpack('!bi',data)

def start_process(command,env,cwd):
 owner,owner_write=os.pipe()
 result_read=result=None
 proc=None
 try:
  result_read,result=os.pipe()
  proc=subprocess.Popen([sys.executable,'-c',_MCP_GUARD,str(owner),str(result)]+command,
   env=env,cwd=cwd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
   start_new_session=True,pass_fds=(owner,result))
  os.close(owner);owner=None
  os.close(result);result=None
  kind,value=read_status(result_read,time.monotonic()+5)
  if kind==1:raise OSError(value,os.strerror(value))
  if kind!=2 or value<=0:raise RuntimeError('process_start_unverified')
  return proc,owner_write,result_read,value
 except BaseException:
  try:
   if proc is not None:
    try:
     try:os.killpg(proc.pid,signal.SIGKILL)
     except ProcessLookupError:pass
    finally:
     try:proc.wait(timeout=5)
     finally:
      for stream in (proc.stdin,proc.stdout,proc.stderr):stream.close()
  finally:
   os.close(owner_write)
   if result_read is not None:os.close(result_read)
  raise
 finally:
  for fd in (owner,result):
   if fd is not None:os.close(fd)

def read_stderr(stream,deadline,limit):
 data=bytearray()
 os.set_blocking(stream.fileno(),False)
 with selectors.DefaultSelector() as ready:
  ready.register(stream,selectors.EVENT_READ)
  while len(data)<=limit and time.monotonic()<deadline:
   if not ready.select(max(0,deadline-time.monotonic())):return bytes(data),False
   try:chunk=os.read(stream.fileno(),min(4096,limit+1-len(data)))
   except BlockingIOError:continue
   if not chunk:return bytes(data),True
   data.extend(chunk)
 return bytes(data[:limit]),False

def finish_process(proc,owner,result):
 cleanup_error=None
 cleanup_deadline=time.monotonic()+3
 code=None
 raw,complete=b'',False
 try:
  try:
   try:os.write(owner,b'F')
   except OSError as exc:cleanup_error=type(exc).__name__
   # Signal while the unreaped session leader still pins the group identity.
   try:os.killpg(proc.pid,signal.SIGTERM)
   except ProcessLookupError:pass
   except OSError as exc:cleanup_error=cleanup_error or type(exc).__name__
   try:raw,complete=read_stderr(proc.stderr,cleanup_deadline,16384)
   except (OSError,ValueError) as exc:cleanup_error=cleanup_error or type(exc).__name__
   if not complete and len(raw)==16384:cleanup_error=cleanup_error or 'stderr_incomplete'
   try:
    kind,code=read_status(result,cleanup_deadline+1)
    if kind!=0:
     code=None
     cleanup_error=cleanup_error or 'process_status_invalid'
   except (OSError,ValueError,RuntimeError) as exc:cleanup_error=cleanup_error or type(exc).__name__
  finally:
   # Always stop the group: a descendant may have closed all inherited pipes.
   try:os.killpg(proc.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   except OSError as exc:cleanup_error=cleanup_error or type(exc).__name__
   try:proc.wait(timeout=5)
   except (OSError,subprocess.TimeoutExpired) as exc:cleanup_error=cleanup_error or type(exc).__name__
  if not complete and len(raw)<16384:
   try:
    tail,complete=read_stderr(proc.stderr,time.monotonic()+1,16384-len(raw))
    raw+=tail
   except (OSError,ValueError) as exc:cleanup_error=cleanup_error or type(exc).__name__
  if not complete:cleanup_error=cleanup_error or 'stderr_incomplete'
  err=raw.decode(errors='replace')
 finally:
  for fd in (owner,result):
   try:os.close(fd)
   except OSError as exc:cleanup_error=cleanup_error or type(exc).__name__
  for stream in (proc.stdin,proc.stdout,proc.stderr):
   try:stream.close()
   except OSError as exc:cleanup_error=cleanup_error or type(exc).__name__
 return err,cleanup_error,code

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
    proc,owner,result_fd,server_pid=start_process([command]+args,env,options.get('cwd') or str(r))
    selector=None;pending=bytearray()
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
     selector=selectors.DefaultSelector()
     selector.register(proc.stdout,selectors.EVENT_READ)
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
     opened=subprocess.run(['/usr/sbin/lsof','-a','-p',str(server_pid),'-d','txt','-Fn'],capture_output=True,text=True,timeout=5)
     row['observed_executable_paths']=[v[1:] for v in opened.stdout.splitlines() if v.startswith('n') and ('/node' in v or '/python' in v)]
    finally:
     row['cleanup_error']='incomplete'
     try:err,cleanup_error,process_exit=finish_process(proc,owner,result_fd)
     finally:
      if selector is not None:selector.close()
     row['process_exit']=process_exit
     row['stderr_bytes']=len(err)
     if cleanup_error:
      row['cleanup_error']=cleanup_error
      raise RuntimeError('mcp_cleanup_unverified')
     del row['cleanup_error']
     if process_exit not in (0,-15,-9):
      for k,v in env.items():
       if len(v)>8 and any(w in k.upper() for w in ['KEY','TOKEN','SECRET']):err=err.replace(v,'[redacted]')
      row['startup_error_excerpt']=re.sub(r'[A-Za-z0-9_+=/.-]{40,}','[redacted]',err)[:1500]
     row['startup_error_codes']=sorted(set(re.findall(r'MS365_[A-Z0-9_]+|AGENT365_[A-Z0-9_]+|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ENOENT|keychain[^\n]{0,100}|Keychain[^\n]{0,100}|API key[^\n]{0,100}|bridge is not ready:[^\n]{0,180}|Error:[^\n]{0,180}',err)))
   except Exception as e:row['error']=str(e) if isinstance(e,RuntimeError) else type(e).__name__
print(json.dumps(out))
