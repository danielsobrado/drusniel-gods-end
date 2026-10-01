import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameSlack } from '../src/core/FrameSlack.js';
import { ViewCullBudget } from '../src/foliage/InstanceViewCuller.js';

function clock() {
  const state = { t: 0 };
  return { state, now: () => state.t };
}

test('deferred work gets the full budget until a frame has been measured', () => {
  const { now } = clock();
  const slack = new FrameSlack({ now });
  assert.equal(slack.available(0.25, 2), 2);
});

test('slack shrinks with the fixed cost of the frame and never drops below the floor', () => {
  const { state, now } = clock();
  const slack = new FrameSlack({ targetMs: 7, reserveMs: 0.5, smoothing: 1, now });
  slack.beginFrame();
  state.t += 4; // fixed work
  slack.defer(() => { state.t += 3; }); // deferred work is not counted as fixed
  slack.endFrame();
  assert.equal(slack.fixedMs, 4);
  slack.beginFrame();
  assert.equal(slack.available(0.25, 2), 2); // 7 - 0.5 - 4 = 2.5, capped at 2
  slack.defer(() => { state.t += 1.5; });
  assert.equal(slack.available(0.25, 2), 1); // 2.5 - 1.5 already spent this frame
  slack.endFrame();

  slack.beginFrame();
  state.t += 9; // an overloaded frame
  slack.endFrame();
  slack.beginFrame();
  assert.equal(slack.available(0.25, 2), 0.25);
});

test('the fixed cost is smoothed so one slow frame does not starve deferred work', () => {
  const { state, now } = clock();
  const slack = new FrameSlack({ targetMs: 7, reserveMs: 0.5, smoothing: 0.1, now });
  for (let i = 0; i < 3; i += 1) { slack.beginFrame(); state.t += 4; slack.endFrame(); }
  slack.beginFrame(); state.t += 14; slack.endFrame();
  assert.ok(slack.fixedMs < 5.1 && slack.fixedMs > 4.9);
});

test('a frame can lower the view-cull budget but not raise it', () => {
  const { state, now } = clock();
  const budget = new ViewCullBudget({ budgetMs: 1.5, now });
  budget.begin(0.5);
  assert.equal(budget.remaining(), 0.5);
  budget.begin(9);
  assert.equal(budget.remaining(), 1.5);
  budget.begin();
  assert.equal(budget.remaining(), 1.5);
  state.t += 2;
  assert.equal(budget.exhausted, true);
});
