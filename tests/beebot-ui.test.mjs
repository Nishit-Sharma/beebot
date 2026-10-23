import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskNavigation,taskTitle,beeMark} from '../public/visuals.mjs';
test('BeeBot sidebar groups only explicit example provenance and hides reversibly without mutating task data',()=>{
 const tasks=[{id:'real',mode:'codex',messages:[{role:'user',text:'Test my workshop plan'}],steps:[{title:'30-minute workshop',receipt:{artifactId:'result'}}]},{id:'example',mode:'fixture'},{id:'synthetic',mode:'codex',source:{type:'synthetic-evaluation'}}];
 const before=structuredClone(tasks);
 assert.deepEqual(taskNavigation(tasks).current.map(x=>x.id),['real']);
 assert.deepEqual(taskNavigation(tasks).examples.map(x=>x.id),['example','synthetic']);
 assert.deepEqual(taskNavigation(tasks,['real']).hidden.map(x=>x.id),['real']);
 assert.equal(taskNavigation(tasks,[]).current[0].id,'real');
 assert.deepEqual(tasks,before);
 assert.equal(taskTitle(tasks[0]),'30-minute workshop');
 assert.match(beeMark(),/viewBox="0 0 32 32"/);
 assert.doesNotMatch(beeMark(),/<script|<image|https?:/);
});
test('Tasks output count uses current receipts rather than historical versions with reused step IDs',async()=>{
 const {currentOutputCount}=await import('../public/visuals.mjs');
 assert.equal(currentOutputCount({steps:[{id:'agenda',status:'completed',receipt:{artifactId:'new'}}],artifacts:[{id:'old',stepId:'agenda'},{id:'new',stepId:'agenda'}]}),1);
});

test('live update controls require mapped real selected source and unexpired unpaused Follow, not discovery',async()=>{
 const {beeStreamControls,beeStreamError}=await import('../public/visuals.mjs');
 const source={id:'selected',conversationId:'42',conversationUuid:'uuid',simulated:false};
 const follow={source:'selected',expiresAt:2000};
 const state={sources:[source],follows:[follow],bee:{},worker:{supervision:{discoveryEnabled:true}}};
 assert.equal(beeStreamControls({worker:state.worker},{now:1000}).canStart,false);
 assert.equal(beeStreamControls({...state,follows:[]},{now:1000}).canStart,false);
 for(const invalid of [{expiresAt:1000},{pausedReason:'OwnerPaused'},{pausedReason:'ProposalLimitReached'}])
  assert.equal(beeStreamControls({...state,follows:[{...follow,...invalid}]},{now:1000}).canStart,false);
 for(const invalid of [{deleted:true},{simulated:true},{conversationUuid:null},{conversationId:null}])
  assert.equal(beeStreamControls({...state,sources:[{...source,...invalid}]},{now:1000}).canStart,false);
 assert.equal(beeStreamControls(state,{now:1000}).canStart,true);
 assert.equal(beeStreamControls(state,{now:1000,pending:true}).canStart,false);
 const reconnect={...state,worker:{supervision:{desiredStream:true}},bee:{connected:false}};
 assert.deepEqual([beeStreamControls(reconnect,{now:1000}).canStart,beeStreamControls(reconnect,{now:1000}).canStop],[false,true]);
 assert.equal(beeStreamControls({...reconnect,worker:{supervision:{desiredStream:false}}},{now:1000}).canStart,true);
 assert.match(beeStreamControls(state,{now:2000}).help,/confirm the displayed scope/);
 assert.match(beeStreamError('SelectAndFollowMappedBeeConversationFirst'),/Watching for new conversations alone is not enough/);
 assert.equal(beeStreamError('Other real failure'),'Other real failure');
 assert.deepEqual(state.follows,[follow]);
});

test('real growing structured response renders readable incremental text without raw JSON or duplicates',async()=>{
 const {proposalStreamSections,renderLiveProposal,beeSourceStatus}=await import('../public/visuals.mjs');
 const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const first='{"reply":"Here is';const second=first+' your plan.","questions":[],"steps":[{"content":"# Agenda\\nWelcome <script>';
 assert.deepEqual(proposalStreamSections(first),['Here is']);
 const html=renderLiveProposal({status:'thinking',stream:second},escape);
 assert.match(html,/Here is your plan/);assert.match(html,/Welcome &lt;script&gt;/);assert.doesNotMatch(html,/<script>|"reply"|"content"/);
 assert.equal((html.match(/Here is your plan/g)??[]).length,1);
 for(const status of ['review_required','failed','cancelled','paused','interrupted'])assert.equal(renderLiveProposal({status,stream:second},escape),'');
 assert.equal(renderLiveProposal({status:'thinking',stream:''},escape),'');
 assert.deepEqual(proposalStreamSections('{"reply":"a\\nquote \\"ok\\" \\u26'),['a\nquote "ok" ']);
 assert.equal(beeSourceStatus('COMPLETED'),'Ready');assert.equal(beeSourceStatus('PROCESSING'),'Processing');
});

test('stream preview ignores nested reply decoys and revoked context, including split escapes',async()=>{
 const {proposalStreamSections,renderLiveProposal}=await import('../public/visuals.mjs');
 const raw=JSON.stringify({metadata:{reply:'DECOY'},reply:'Real "reply" 😀',steps:[{content:'Useful draft'}]});
 assert.deepEqual(proposalStreamSections(raw),['Real "reply" 😀','Useful draft']);
 assert.deepEqual(proposalStreamSections('{"metadata":{"reply":"DECOY"},"reply":"Real \\uD83D'),['Real ']);
 assert.equal(renderLiveProposal({status:'thinking',sourceRevoked:true,stream:raw},s=>s),'');
});
test('SSE and poll snapshot refreshes coalesce and cannot apply an older response after a newer one',async()=>{
 const {createCoalescedRefresh}=await import('../public/visuals.mjs');let calls=0,active=0,max=0,finish;const applied=[];
 const refresh=createCoalescedRefresh(async()=>{const n=++calls;active++;max=Math.max(max,active);if(n===1)await new Promise(r=>finish=r);applied.push(n);active--;});
 const first=refresh();const next=refresh();refresh();assert.equal(calls,1);finish();await Promise.all([first,next]);assert.equal(max,1);assert.deepEqual(applied,[1,2]);
 await refresh();assert.deepEqual(applied,[1,2,3]);
});

test('composer Enter submits, while Shift Enter and input-method confirmation keep native editing',async()=>{
 const {shouldSubmitComposer}=await import('../public/visuals.mjs');
 assert.equal(shouldSubmitComposer({key:'Enter'}),true);
 for(const modifiers of [{shiftKey:true},{isComposing:true},{keyCode:229},{ctrlKey:true},{altKey:true},{metaKey:true}])assert.equal(shouldSubmitComposer({key:'Enter',...modifiers}),false);
 assert.equal(shouldSubmitComposer({key:'a'}),false);
});


test('archived task presentation stays reversible and does not mutate saved records',()=>{
 const archived={id:'old',mode:'codex',presentationArchived:true,messages:[{role:'user',text:'A real task'}]};
 const records=[archived,{id:'new',mode:'codex'}];
 const before=structuredClone(records);
 assert.deepEqual(taskNavigation(records).current.map(c=>c.id),['new']);
 assert.deepEqual(taskNavigation(records).hidden.map(c=>c.id),['old']);
 const restored=records.map(c=>c.id==='old'?{...c,presentationArchived:false}:c);
 assert.deepEqual(taskNavigation(restored).current.map(c=>c.id),['old','new']);
 assert.deepEqual(records,before);
});
