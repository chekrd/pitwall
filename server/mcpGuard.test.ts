import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { changesSomething } from './mcpGuard.ts';

test('MCP tools that change something are denied', () => {
  for (const name of [
    'mcp__plugin_atlassian_atlassian__createJiraIssue',
    'mcp__plugin_atlassian_atlassian__addOrEditJiraIssueComment',
    'mcp__plugin_atlassian_atlassian__addGraphContext',
    'mcp__plugin_atlassian_atlassian__editJiraIssue',
    'mcp__plugin_atlassian_atlassian__transitionJiraIssue',
    'mcp__plugin_atlassian_atlassian__updateConfluenceContent',
    'mcp__plugin_atlassian_atlassian__executeWrite',
    'mcp__plugin_atlassian_atlassian__executeDestructive',
    'mcp__claude_ai_Claude_Docs__batch',
    'mcp__claude_ai_Claude_Docs__update',
    'mcp__claude_ai_Claude_Docs__create',
    'mcp__claude_ai_Claude_Docs__delete',
    'mcp__claude-in-chrome__file_upload',
    'mcp__claude-in-chrome__upload_image',
    'mcp__github__push_files',
    'mcp__github__fork_repository',
    'mcp__supabase__execute_sql',
    'mcp__supabase__apply_migration',
    'mcp__linear__save_issue',
    'mcp__vercel__deploy_to_vercel',
    'mcp__slack__set_status',
    'mcp__plugin_sentry_sentry__authenticate',
    'mcp__pitwall__create_artifact',
    'mcp__anything__frobnicate',
  ]) assert.equal(changesSomething(name), true, name);
});

test('reading and browser tools are allowed', () => {
  for (const name of [
    'mcp__plugin_atlassian_atlassian__getJiraIssue',
    'mcp__plugin_atlassian_atlassian__executeRead',
    'mcp__plugin_atlassian_atlassian__searchConfluence',
    'mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql',
    'mcp__plugin_atlassian_atlassian__listJiraIssueComments',
    'mcp__plugin_atlassian_atlassian__getAccessibleAtlassianResources',
    'mcp__plugin_atlassian_atlassian__atlassianUserInfo',
    'mcp__plugin_atlassian_atlassian__discover',
    'mcp__plugin_atlassian_atlassian__search',
    'mcp__claude_ai_Claude_Docs__export',
    'mcp__claude_ai_Claude_Docs__read',
    'mcp__claude_ai_Claude_Docs__query',
    'mcp__github__get_workflow_run',
    'mcp__plugin_sentry_sentry__find_issues',
    'mcp__brave-devtools__click',
    'mcp__brave-devtools__navigate_page',
    'mcp__brave-devtools__evaluate_script',
    'mcp__claude-in-chrome__tabs_create_mcp',
    'mcp__claude-in-chrome__computer',
    'mcp__claude-in-chrome__form_input',
    'mcp__remote-devices__Claude_Browser__navigate',
    'mcp__pitwall-advisor__scratch_copy',
  ]) assert.equal(changesSomething(name), false, name);
});

test('only MCP tool names are judged', () => {
  assert.equal(changesSomething('Write'), false);
  assert.equal(changesSomething('mcp__server'), false);
});

const hook = (input: string) => spawnSync(process.execPath, [join(import.meta.dirname, 'mcpGuard.ts')], { input, encoding: 'utf8' });

test('the hook blocks with exit code 2 what it denies or cannot read, and lets reads through', () => {
  const denied = hook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'mcp__github__push_files', tool_input: {} }));
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /push_files/);
  for (const input of ['', 'not json', '{}', JSON.stringify({ tool_name: 42 })]) {
    const unread = hook(input);
    assert.equal(unread.status, 2, input);
    assert.match(unread.stderr, /could not read the tool call/);
  }
  const read = hook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_atlassian_atlassian__getJiraIssue', tool_input: {} }));
  assert.equal(read.status, 0);
  assert.equal(read.stdout, '');
});
