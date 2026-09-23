// Local provider binaries, isolated empty credential stores; no refresh-token copying.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {requireClaudeAuth,requireCodexAuth} from '../../scripts/dev-environment.mjs';
if(process.env.FOREMAN_LIVE!=='1')test('live dev authentication preflight',{skip:'requires installed provider CLIs'},()=>{});
else for(const provider of ['Claude','Codex'])test(`real ${provider} CLI rejects an empty isolated dev login`,t=>{
  const home=mkdtempSync(join(tmpdir(),'foreman-dev-auth-live-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const config=join(home,provider.toLowerCase());mkdirSync(config,{mode:0o700});
  const env={...process.env,HOME:home};
  for(const key of ['ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CODEX_HOME','CLAUDE_CONFIG_DIR','OPENAI_API_KEY'])delete env[key];
  const check=provider==='Codex'?requireCodexAuth:requireClaudeAuth;
  const binary=provider==='Codex'?'codex':resolve('node_modules','@anthropic-ai',`claude-agent-sdk-${process.platform}-${process.arch}`,'claude');
  let result;
  const execute=(bin,args,options)=>{
    result=spawnSync(bin,args,{...options,encoding:'utf8'});
    if(result.error||result.status!==0)throw Error('CLI rejected authentication');
    return result.stdout;
  };
  assert.throws(()=>check(binary,config,env,execute),new RegExp(`DEV ${provider} is not signed in`));
  assert.ok(result?.pid,'Actual CLI process must run');assert.equal(result.error,undefined);
  assert.match(result.stdout+result.stderr,/not logged in|"loggedIn":\s*false/i);
});
