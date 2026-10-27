import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {validateImage,imageReference,textOnlyHistory,MAX_IMAGE_BYTES} from '../services/attachments.js';
import {toStorableContent} from '../services/message_storage.js';
test('图片验证与元数据提取',async()=>{const data=await sharp({create:{width:16,height:8,channels:3,background:'#fff'}}).png().toBuffer();const image=await validateImage(data.toString('base64'),'image/png');assert.equal(image.width,16);assert.equal(image.height,8);assert.equal(image.mimeType,'image/png');});
test('拒绝 MIME 伪造、损坏数据、SVG 和超限图片',async()=>{const data=await sharp({create:{width:16,height:8,channels:3,background:'#fff'}}).png().toBuffer();await assert.rejects(()=>validateImage(data.toString('base64'),'image/jpeg'));await assert.rejects(()=>validateImage(Buffer.from('not png').toString('base64'),'image/png'));await assert.rejects(()=>validateImage(Buffer.from('<svg/>').toString('base64'),'image/svg+xml'));await assert.rejects(()=>validateImage('A'.repeat(Math.ceil(MAX_IMAGE_BYTES/3)*4+8),'image/png'));});
test('数据库内容只保留稳定附件引用，重复规范化不改变数据',()=>{const ref=imageReference({id:'fixture',mime_type:'image/png',size_bytes:10,file_name:'图片',width:16,height:8});const stored=toStorableContent([ref,{type:'text',text:'调整'}]);assert.equal(JSON.parse(stored)[0].attachmentId,'fixture');assert(!stored.includes('base64'));assert.equal(toStorableContent(JSON.parse(stored)),stored);});
test('历史上下文不自动重读旧图片并保留轮次占位',()=>{const history=textOnlyHistory([{role:'user',content:[{type:'image',attachmentId:'id'}]},{role:'assistant',content:'代码'}]);assert.equal(history.length,2);assert.equal(history[0].content,'[用户在此轮上传过截图]');});
