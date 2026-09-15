import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSuccess, Harness } from './live/harness.mjs';
test('native success requires a correlated completed tool result, not prose or a different operation', () => {
  const command = 'git fetch origin main';
  const claude = [
    {kind:'tool_use',name:'Bash',id:'fetch',input:{command}},
    {kind:'tool_result',tool_use_id:'fetch',is_error:false,content:'verified'},
  ];
  const codex = [{kind:'item/completed',item:{type:'commandExecution',command,exitCode:0,aggregatedOutput:'verified'}}];
  for (const events of [claude,codex]) {
    assertSuccess({events},command,'verified');
    assert.throws(() => assertSuccess({events},'another command','verified'));
    assert.throws(() => assertSuccess({events},command,'missing'));
  }
  for (const events of [[],[{kind:'assistant',text:'verified'}],claude.slice(1),
    [{...claude[0]}, {...claude[1],is_error:true}],
    [{kind:'item/started',item:codex[0].item}],
    [{kind:'item/completed',item:{...codex[0].item,exitCode:1}}]])
    assert.throws(() => assertSuccess({events},command,'verified'));
});
test('reporting checks the requested mode before peer or UI assertions', async () => {
  const h = new Harness(); h.api = async () => ({session:{permission_mode:'bypass'}});
  await assert.rejects(h.reported({requested:'native'}), /bypass.*native/s);
});
