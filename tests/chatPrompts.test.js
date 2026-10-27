import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatContext, validateChatInput, CHAT_SYSTEM_PROMPT } from '../services/chatPrompts.js';
const code = 'function Component() { return <button>原组件</button>; }';
const history = [{ role: 'assistant', content: '```tsx\n' + code + '\n```' }];
test('新增使用服务端生成约束并保留用户需求', () => {
  const result = buildChatContext({ message: '生成卡片' });
  assert.equal(result.message, '生成卡片'); assert(result.system.startsWith(CHAT_SYSTEM_PROMPT)); assert.equal(result.mode, 'new');
});
test('普通调整只使用现有历史，不把源码复制进请求消息', () => {
  const result = buildChatContext({ message: '改成绿色', mode: 'adjust', history });
  assert.equal(result.message, '改成绿色'); assert(result.system.includes('最近一条助手消息')); assert.equal(result.mode, 'adjust');
});
test('作品引用强制调整，源码仅从后端读取的作品对象组装', () => {
  const result = buildChatContext({ message: '改成绿色', mode: 'new', reference: { id: 12, sourceCode: code } });
  assert.equal(result.mode, 'adjust'); assert(result.message.includes(code)); assert(result.message.includes('改成绿色')); assert(result.system.includes('数据'));
});
test('没有组件不能使用调整模式', () => {
  assert.throws(() => buildChatContext({ message: '修改', mode: 'adjust' }), /没有可调整/);
  assert.throws(() => buildChatContext({ message: '修改', mode: 'adjust', history: [...history, { role: 'assistant', content: '普通说明' }] }), /没有可调整/);
});
test('图片与文字保持多模态结构，输入对象不被修改', () => {
  const image={type:'image',source:{type:'base64',media_type:'image/png',data:'fixture-image'}};
  const input=[image,{type:'text',text:''}]; const before=JSON.stringify(input);
  const result=buildChatContext({message:input}); assert.equal(result.message[0],image); assert(result.message[1].text.includes('截图')); assert.equal(JSON.stringify(input),before);
  const referenced=buildChatContext({message:input,reference:{id:1,sourceCode:code}});assert(referenced.message[1].text.includes(code));
});
test('拒绝空消息、未知模式及无效内容块', () => {
  for(const input of ['',[],[{type:'text',text:''}],[{type:'unknown'}],[{type:'text',text:{bad:true}}]]) assert.throws(()=>validateChatInput(input));
  assert.throws(()=>validateChatInput('test','auto'));
});
test('调整支持历史中的文字内容块', () => {
  const result=buildChatContext({message:'换色',mode:'adjust',history:[{role:'assistant',content:[{type:'text',text:'```tsx\n'+code+'\n```'}]}]});assert.equal(result.mode,'adjust');
});


test('新增、普通调整与引用调整均包含容器适配和样式作用域约束', () => {
  const cases = [
    { message: '生成圆环' },
    { message: '调整圆环', mode: 'adjust', history },
    { message: '引用圆环', reference: { id: 1, sourceCode: code } },
  ];
  for (const input of cases) {
    const { system } = buildChatContext(input);
    for (const constraint of ['minWidth: 0', 'viewBox', 'aspectRatio', 'overflowX: auto', '不得修改 html', '不要依赖预览器未加载的 Tailwind']) {
      assert(system.includes(constraint));
    }
  }
});
