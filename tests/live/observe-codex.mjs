export function observeCodex(control, cwd, record) {
  const write = control.write.bind(control);
  control.write = (message) => {
    if (message.result?.permissions) record({ cwd, kind:'permission_refusal', result:message.result });
    if (message.result?.contentItems) record({ cwd, kind:'tool_result', id:message.id, result:message.result });
    return write(message);
  };
  control.on('notification', (message) => {
    if (['item/started','item/completed'].includes(message.method)) record({cwd,kind:message.method,item:message.params.item});
  });
}
