"""Unit tests for david-force. Run: python3 -m unittest discover -s skill/david-force/tests"""
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'scripts'))
import common  # noqa: E402
import force  # noqa: E402
import force_guard  # noqa: E402
import force_hook  # noqa: E402

CASES = json.loads((ROOT / 'tests' / 'commands.json').read_text())


class Sandbox(unittest.TestCase):
    """A fake machine: its own HOME, state folder, Codex and DeepSeek homes. Nothing real is read or written."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='david-force-test-')
        t = Path(self.tmp)
        self.home = t / 'home'
        for d in ('.codex', '.dsh', '.claude/skills', '.agents/skills', 'work'):
            (self.home / d).mkdir(parents=True)
        self.env = mock.patch.dict(os.environ, {
            'HOME': str(self.home), 'DAVID_FORCE_HOME': str(t / 'state'),
            'DAVID_FORCE_CODEX_HOME': str(self.home / '.codex'), 'DAVID_FORCE_CLAUDE_HOME': str(self.home / '.claude'), 'DAVID_FORCE_DSH_HOME': str(self.home / '.dsh'),
            'DAVID_FORCE_SKILLS_HOME': str(self.home / '.claude' / 'skills'),
            'DAVID_FORCE_AGENTS_SKILLS_HOME': str(self.home / '.agents' / 'skills'),
            'DAVID_FORCE_TMP_ALLOW': ''}, clear=False)  # the sandbox itself lives in a temp dir
        self.env.start()
        os.environ.pop('DAVID_FORCE_OFF', None)
        self.repo = self.home / 'work' / 'repo'
        (self.repo / '.git').mkdir(parents=True)
        (self.repo / 'src').mkdir()
        self.addCleanup(self.env.stop)

    def run_cli(self, fn):
        buf = io.StringIO()
        with redirect_stdout(buf):
            fn()
        return buf.getvalue()


class CommandClassifier(unittest.TestCase):
    def test_shared_fixture(self):
        wrong = [c['cmd'] for c in CASES if common.command_modifies(c['cmd']) != c['modifies']]
        self.assertEqual(wrong, [])


class Decision(Sandbox):
    def deny(self, tool, args, cwd=None, flavor='codex'):
        return common.reason_to_deny(tool, args, cwd or str(self.repo), flavor)

    def test_shell_write_in_a_repo_is_denied_with_the_way_out(self):
        r = self.deny('Bash', {'command': 'echo x > src/a.js'})
        self.assertIn('david-force is ON', r)
        self.assertIn('david run', r)
        self.assertIn('david_run', self.deny('bash', {'command': 'rm src/a.js'}, flavor='deepseek'))

    def test_reads_and_david_itself_are_never_denied(self):
        for cmd in ('ls src', 'git status', 'grep -rn foo .', '~/.david-force/bin/david run --cwd . "fix it" > out.txt',
                    'david ask "where is x" > /dev/null'):
            self.assertIsNone(self.deny('Bash', {'command': cmd}), cmd)

    def test_the_same_write_outside_a_repo_is_fine(self):
        self.assertIsNone(self.deny('Bash', {'command': 'echo x > a.txt'}, cwd=str(self.home / 'work')))
        self.assertIsNone(self.deny('bash', {'command': 'echo x > ~/.dsh/AGENTS.md'}, cwd=str(self.repo)),
                          'a plain redirect is judged by where it writes, not by the cwd it runs in')
        self.assertIsNone(self.deny('bash', {'command': 'cd ~/.dsh && sed -i "" s/a/b/ AGENTS.md'}, cwd=str(self.repo)),
                          'a cd moves the working directory out of the repo')
        self.assertIsNotNone(self.deny('bash', {'command': 'cp /tmp/a.js src/a.js'}),
                             'a verb with a relative target still counts the cwd')

    def test_a_cd_into_a_repo_counts(self):
        self.assertIsNotNone(self.deny('bash', {'command': f'cd {self.repo} && sed -i "" s/a/b/ src/a.js'}, cwd=str(self.home)))

    def test_edit_tools_by_path(self):
        self.assertIsNotNone(self.deny('Edit', {'file_path': str(self.repo / 'src' / 'a.js')}, cwd=str(self.home)))
        self.assertIsNotNone(self.deny('write', {'file_path': 'src/new.js'}))  # relative: resolved against the cwd
        self.assertIsNone(self.deny('write', {'file_path': str(self.home / '.dsh' / 'x.md')}))
        self.assertIsNone(self.deny('write', {'file_path': str(self.home / 'work' / 'loose.txt')}))

    def test_apply_patch_paths_are_read_from_the_patch(self):
        patch = '*** Begin Patch\n*** Update File: src/a.js\n@@\n-a\n+b\n*** End Patch\n'
        self.assertIsNotNone(self.deny('apply_patch', {'input': patch}))
        self.assertIsNotNone(self.deny('apply_patch', {'command': ['apply_patch', patch]}))
        outside = f'*** Begin Patch\n*** Add File: {self.home}/.dsh/n.md\n+x\n*** End Patch\n'
        self.assertIsNone(self.deny('apply_patch', {'input': outside}, cwd=str(self.home)))

    def test_a_repo_rooted_at_home_does_not_count(self):
        (self.home / '.git').mkdir()
        loose = self.home / 'notes'
        loose.mkdir()
        self.assertIsNone(self.deny('Bash', {'command': 'echo x > a.txt'}, cwd=str(loose)))
        self.assertIsNotNone(self.deny('Bash', {'command': 'echo x > a.txt'}), 'the real repo below it still counts')

    def test_allow_file_adds_prefixes(self):
        state = Path(os.environ['DAVID_FORCE_HOME'])
        state.mkdir(parents=True)
        (state / 'allow.txt').write_text(f'# mine\n{self.repo}\n')
        self.assertIsNone(self.deny('Bash', {'command': 'echo x > a.txt'}))

    def test_unknown_tools_and_bad_input_are_allowed(self):
        self.assertIsNone(self.deny('mcp__slack__send', {'text': 'hi'}))
        self.assertIsNone(self.deny('Read', {'file_path': str(self.repo / 'src' / 'a.js')}))
        self.assertIsNone(common.reason_to_deny('Bash', None, '', 'codex'))
        self.assertIsNone(self.deny('Bash', {'command': None}))


class State(Sandbox):
    def test_default_is_off_and_a_broken_file_is_off(self):
        self.assertFalse(common.is_on('deepseek'))
        common.force_home().mkdir(parents=True)
        common.state_path().write_text('{not json')
        self.assertFalse(common.is_on('deepseek'))

    def test_each_harness_has_its_own_switch(self):
        common.write_state({'deepseek': True})
        self.assertEqual(common.current_harnesses(), {'deepseek': True, 'codex': False, 'claude': False})
        self.assertTrue(common.enabled('deepseek'))
        self.assertFalse(common.enabled('codex'), 'DeepSeek on never reaches Codex')
        self.assertFalse(common.enabled('claude'))
        common.write_state({'codex': True})
        self.assertEqual(common.current_harnesses(), {'deepseek': True, 'codex': True, 'claude': False}, 'merged, not replaced')
        common.write_state({'deepseek': False})
        self.assertEqual(common.current_harnesses(), {'deepseek': False, 'codex': True, 'claude': False})

    def test_is_on_follows_the_harness_the_hook_names(self):
        common.write_state({'claude': True})
        with mock.patch.dict(os.environ, {'DAVID_FORCE_HARNESS': 'claude'}):
            self.assertTrue(common.is_on())
        with mock.patch.dict(os.environ, {'DAVID_FORCE_HARNESS': 'codex'}):
            self.assertFalse(common.is_on())
        self.assertFalse(common.is_on(), 'a hook that names no harness is Codex\'s')

    def test_a_state_file_from_before_the_switches_meant_the_deepseek_harness(self):
        common.force_home().mkdir(parents=True)
        common.state_path().write_text('{"on": true}')
        self.assertEqual(common.current_harnesses(), {'deepseek': True, 'codex': False, 'claude': False})
        self.assertFalse(common.enabled('codex'))

    def test_bool_shorthand_and_the_escape_variable(self):
        common.write_state(True)
        self.assertTrue(common.enabled('deepseek'))
        with mock.patch.dict(os.environ, {'DAVID_FORCE_OFF': '1'}):
            self.assertFalse(common.enabled('deepseek'))
        common.write_state(False)
        self.assertFalse(common.enabled('deepseek'))
        self.assertFalse(json.loads(common.state_path().read_text())['on'])


class Guard(Sandbox):
    def payload(self, **kw):
        return {'hook_event_name': 'PreToolUse', 'tool_name': 'Bash', 'tool_input': {'command': 'echo x > src/a.js'},
                'cwd': str(self.repo), **kw}

    def test_off_prints_nothing_on_prints_a_deny(self):
        self.assertIsNone(force_guard.decide(self.payload()))
        common.write_state({'codex': True})
        reason = force_guard.decide(self.payload())
        self.assertIn('david', reason)
        self.assertIsNone(force_guard.decide(self.payload(tool_input={'command': 'ls'})))

    def test_script_output_is_the_codex_deny_json_and_it_fails_open(self):
        common.write_state({'codex': True})
        env = {**os.environ}
        run = lambda stdin: subprocess.run([sys.executable, str(ROOT / 'scripts' / 'force_guard.py')], input=stdin,
                                           capture_output=True, text=True, env=env)
        out = run(json.dumps(self.payload()))
        data = json.loads(out.stdout)['hookSpecificOutput']
        self.assertEqual((data['hookEventName'], data['permissionDecision']), ('PreToolUse', 'deny'))
        self.assertEqual(out.returncode, 0)
        for junk in ('', 'not json', '[]', '{"tool_name": 5}'):
            r = run(junk)
            self.assertEqual((r.stdout, r.returncode), ('', 0), repr(junk))


class Hooks(Sandbox):
    def fire(self, event, sid='s1', **kw):
        return force_hook.handle({'hook_event_name': event, 'session_id': sid, **kw})

    def test_off_is_silent_and_writes_nothing(self):
        for ev in ('UserPromptSubmit', 'PostToolUse', 'Stop'):
            self.assertIsNone(self.fire(ev))
        self.assertFalse((common.force_home() / 'sessions').exists())

    def test_prompt_reminder_and_stop_blocks_once_per_turn(self):
        common.write_state({'codex': True})
        out = self.fire('UserPromptSubmit')
        self.assertIn('david', out['hookSpecificOutput']['additionalContext'])
        for _ in range(force_hook.STOP_MIN):
            self.fire('PostToolUse', tool_name='Bash', tool_input={'command': 'ls'})
        first = self.fire('Stop')
        self.assertEqual(first['decision'], 'block')
        self.assertIn('david', first['reason'])
        self.assertIsNone(self.fire('Stop'), 'once per turn')
        self.assertIsNone(self.fire('Stop', stop_hook_active=True))

    def test_a_turn_that_used_david_or_did_little_is_left_alone(self):
        common.write_state({'codex': True})
        self.fire('UserPromptSubmit')
        for _ in range(force_hook.STOP_MIN + 3):
            self.fire('PostToolUse', tool_name='Bash', tool_input={'command': '~/.david-force/bin/david ask "q"'})
        self.assertIsNone(self.fire('Stop'))
        self.fire('UserPromptSubmit', sid='s2')
        self.fire('PostToolUse', sid='s2', tool_name='Bash', tool_input={'command': 'ls'})
        self.assertIsNone(self.fire('Stop', sid='s2'))

    def test_a_new_prompt_resets_the_turn(self):
        common.write_state({'codex': True})
        self.fire('UserPromptSubmit')
        for _ in range(force_hook.STOP_MIN):
            self.fire('PostToolUse', tool_name='Bash', tool_input={'command': 'ls'})
        self.assertIsNotNone(self.fire('Stop'))
        self.fire('UserPromptSubmit')
        for _ in range(force_hook.STOP_MIN):
            self.fire('PostToolUse', tool_name='Bash', tool_input={'command': 'ls'})
        self.assertIsNotNone(self.fire('Stop'), 'a new turn may be sent back again')


class Control(Sandbox):
    def seed(self):
        (self.home / '.codex' / 'AGENTS.md').write_text('# mine\nkeep this\n')
        (self.home / '.dsh' / 'AGENTS.md').write_text('# ds\n')
        (self.home / '.claude' / 'CLAUDE.md').write_text('# claude mine\n')
        gk = {'hooks': {'PreToolUse': [{'hooks': [{'type': 'command', 'command': 'gk hook'}], 'matcher': ''}]}}
        (self.home / '.codex' / 'hooks.json').write_text(json.dumps(gk))
        (self.home / '.claude' / 'settings.json').write_text(json.dumps({'model': 'x', 'hooks': {'Stop': [
            {'hooks': [{'type': 'command', 'command': 'mission'}]}]}}))

    def texts(self):
        return tuple((self.home / d).read_text() for d in ('.codex/AGENTS.md', '.dsh/AGENTS.md', '.claude/CLAUDE.md'))

    def test_install_does_not_turn_anything_on_and_keeps_other_hooks(self):
        self.seed()
        claude_before = (self.home / '.claude' / 'settings.json').read_text()
        out = self.run_cli(lambda: print('\n'.join(force.install())))
        self.assertFalse(any(common.current_harnesses().values()))
        self.assertTrue(force.hooks_installed('codex'))
        self.assertFalse(force.hooks_installed('claude'))
        self.assertEqual((self.home / '.claude' / 'settings.json').read_text(), claude_before, 'install leaves Claude alone')
        hooks = json.loads((self.home / '.codex' / 'hooks.json').read_text())['hooks']
        self.assertEqual(len(hooks['PreToolUse']), 2, 'ours is added, the other one stays')
        self.assertIn('DAVID_FORCE_HARNESS=codex', hooks['PreToolUse'][1]['hooks'][0]['command'])
        self.assertTrue((common.force_home() / 'bin' / 'david').is_symlink())
        self.assertTrue((self.home / '.claude' / 'skills' / 'david-force' / 'SKILL.md').exists())
        self.assertTrue((self.home / '.codex' / 'skills' / 'david-force').is_symlink())
        self.assertTrue((self.home / '.agents' / 'skills' / 'david-force').is_symlink())
        self.assertIn('hooks added', out)
        self.assertEqual(force.install(), [], 'a second install changes nothing')

    def test_plain_on_is_the_deepseek_harness_only(self):
        self.seed()
        before = self.texts()
        codex_hooks = (self.home / '.codex' / 'hooks.json').read_text()
        claude_settings = (self.home / '.claude' / 'settings.json').read_text()
        out = '\n'.join(force.turn_on(force.parse_targets([], ['deepseek'])))
        self.assertEqual(common.current_harnesses(), {'deepseek': True, 'codex': False, 'claude': False})
        codex, dsh, claude = self.texts()
        self.assertIn('david_run', dsh)
        self.assertEqual((codex, claude), (before[0], before[2]), 'Codex and Claude files are untouched')
        self.assertEqual((self.home / '.codex' / 'hooks.json').read_text(), codex_hooks)
        self.assertEqual((self.home / '.claude' / 'settings.json').read_text(), claude_settings)
        self.assertIn('not governed', out)
        self.assertIn('codex', out.split('not governed')[1])

    def test_on_codex_and_on_claude_are_opt_in_and_independent(self):
        self.seed()
        force.turn_on(['codex'])
        self.assertEqual(common.current_harnesses(), {'deepseek': False, 'codex': True, 'claude': False})
        self.assertIn('david-force:begin', self.texts()[0])
        self.assertTrue(force.hooks_installed('codex'))
        self.assertFalse(force.hooks_installed('claude'))
        self.assertEqual(self.texts()[2], '# claude mine\n')
        force.turn_on(['claude'])
        self.assertTrue(force.hooks_installed('claude'))
        settings = json.loads((self.home / '.claude' / 'settings.json').read_text())
        self.assertEqual(settings['model'], 'x', 'the rest of settings.json is kept')
        self.assertEqual(settings['hooks']['Stop'][0]['hooks'][0]['command'], 'mission', 'the owner\'s own hook stays')
        pre = settings['hooks']['PreToolUse'][0]
        self.assertEqual(pre['matcher'], 'Bash|Edit|Write|MultiEdit|NotebookEdit')
        self.assertIn('DAVID_FORCE_HARNESS=claude', pre['hooks'][0]['command'])
        self.assertIn('/.claude/skills/david-force/scripts/force_guard.py', pre['hooks'][0]['command'])
        self.assertIn('david-force:begin', self.texts()[2])
        force.turn_off(['codex'])
        self.assertEqual(common.current_harnesses(), {'deepseek': False, 'codex': False, 'claude': True})
        self.assertNotIn('david-force', self.texts()[0])
        self.assertIn('david-force:begin', self.texts()[2], 'off codex does not touch Claude')

    def test_all_and_bare_off(self):
        self.seed()
        before = self.texts()
        force.turn_on(force.parse_targets(['all'], ['deepseek']))
        self.assertEqual(common.current_harnesses(), {'deepseek': True, 'codex': True, 'claude': True})
        force.turn_on(['deepseek'])
        self.assertEqual(self.texts()[1].count('david-force:begin'), 1, 'on twice does not stack blocks')
        force.turn_off(force.parse_targets([], list(force.HARNESSES)))
        self.assertEqual(common.current_harnesses(), {'deepseek': False, 'codex': False, 'claude': False})
        self.assertEqual(self.texts(), before, 'every file is back exactly as it was')
        self.assertTrue(force.hooks_installed('codex'), 'off leaves the hooks in place; they do nothing')

    def test_unknown_target_is_refused(self):
        with self.assertRaises(SystemExit):
            force.parse_targets(['gemini'], ['deepseek'])
        self.assertEqual(force.parse_targets(['harness', 'deepseek', 'codex'], []), ['deepseek', 'codex'])

    def test_uninstall_removes_everything_it_added(self):
        self.seed()
        force.install()
        force.turn_on(['deepseek', 'codex', 'claude'])
        force.uninstall()
        self.assertFalse(force.hooks_installed('codex'))
        self.assertFalse(force.hooks_installed('claude'))
        hooks = json.loads((self.home / '.codex' / 'hooks.json').read_text())['hooks']
        self.assertEqual(hooks['PreToolUse'][0]['hooks'][0]['command'], 'gk hook')
        self.assertEqual(json.loads((self.home / '.claude' / 'settings.json').read_text())['hooks']['Stop'][0]['hooks'][0]['command'], 'mission')
        self.assertFalse(common.force_home().exists())
        self.assertNotIn('david-force', ''.join(self.texts()))

    def test_a_harness_that_is_not_installed_is_skipped_not_created(self):
        for d in ('.codex', '.dsh', '.claude/skills', '.claude'):
            os.rmdir(self.home / d)
        self.assertEqual(force.blocks(list(force.HARNESSES), True), [])
        self.assertFalse(force.set_hooks('codex', True))
        self.assertFalse(force.set_hooks('claude', True))

    def test_status_reports_each_harness(self):
        self.seed()
        self.assertIn('david-force: OFF', '\n'.join(force.status()))
        force.turn_on(['deepseek'])
        text = '\n'.join(force.status())
        self.assertIn('david-force: ON', text)
        self.assertRegex(text, r'deepseek\s+ON')
        self.assertRegex(text, r'codex\s+off')
        self.assertRegex(text, r'claude\s+off')


class Cli(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(ROOT / 'scripts'))
        import importlib.machinery, importlib.util
        loader = importlib.machinery.SourceFileLoader('david_cli', str(ROOT / 'scripts' / 'david'))
        spec = importlib.util.spec_from_loader('david_cli', loader)
        self.cli = importlib.util.module_from_spec(spec)
        loader.exec_module(self.cli)

    def stream(self, *events):
        return [json.dumps(e) for e in events]

    def run_status(self, argv, dsh=True, patch=True, plugin=True, plugin_text='{"version": "9.9.9"}'):
        """Run `david status ...` against a temp machine; (exit code, stdout, dsh path, patch path)."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        home = root / 'home'
        dsh_path, patch_path = root / 'dsh', root / 'cordis.patch.yml'
        if dsh:
            dsh_path.write_text('')
        if patch:
            patch_path.write_text('')
        if plugin:
            pkg = home / '.dsh' / 'profiles' / 'desktop' / 'plugins' / 'david-plugin' / 'package.json'
            pkg.parent.mkdir(parents=True)
            pkg.write_text(plugin_text)
        buf = io.StringIO()
        with mock.patch.object(self.cli, 'DSH', str(dsh_path)), mock.patch.object(self.cli, 'PATCH', str(patch_path)), \
                mock.patch.object(self.cli.Path, 'home', lambda: home), redirect_stdout(buf):
            code = self.cli.main(list(argv))
        return code, buf.getvalue(), str(dsh_path), str(patch_path)

    def test_status_text_output_is_unchanged_and_exits_0_when_all_checks_pass(self):
        code, out, dsh, patch = self.run_status(['status'])
        self.assertEqual(code, 0)
        self.assertEqual(out, f'ok  Harness runtime {dsh}\nok  desktop patch {patch}\nok  david plugin v9.9.9\n')

    def test_status_json_is_exactly_one_object_when_all_checks_pass(self):
        code, out, dsh, patch = self.run_status(['status', '--json'])
        self.assertEqual(code, 0)
        self.assertEqual(out.count('\n'), 1, 'one JSON line and nothing else')
        self.assertEqual(json.loads(out), {'ok': True, 'checks': [
            {'name': 'Harness runtime', 'ok': True, 'detail': dsh},
            {'name': 'desktop patch', 'ok': True, 'detail': patch},
            {'name': 'david plugin', 'ok': True, 'detail': 'v9.9.9'}]})

    def test_status_a_missing_check_fails_both_modes_with_a_string_detail(self):
        code, out, dsh, _ = self.run_status(['status', '--json'], dsh=False)
        self.assertEqual(code, 1)
        data = json.loads(out)
        self.assertFalse(data['ok'])
        self.assertEqual([c['ok'] for c in data['checks']], [False, True, True])
        self.assertEqual(data['checks'][0]['detail'], dsh)
        self.assertIsInstance(data['checks'][0]['detail'], str)
        self.assertIn('MISSING Harness runtime', self.run_status(['status'], dsh=False)[1])

    def test_status_exit_code_is_the_same_with_and_without_json(self):
        for dsh in (True, False):
            with self.subTest(dsh=dsh):
                self.assertEqual(self.run_status(['status'], dsh=dsh)[0], self.run_status(['status', '--json'], dsh=dsh)[0])

    def test_status_a_malformed_plugin_file_is_ok_with_no_detail(self):
        code, out, _, _ = self.run_status(['status', '--json'], plugin_text='{not json')
        self.assertEqual(code, 0)
        plugin = json.loads(out)['checks'][2]
        self.assertEqual((plugin['ok'], plugin['detail']), (True, ''))

    def test_the_result_is_taken_by_call_id_not_scraped_from_the_reply(self):
        lines = self.stream({'type': 'tool_call', 'tool': 'david_ask', 'callId': 'c1', 'input': {}},
                            {'type': 'tool_call', 'tool': 'david_ask', 'callId': 'c2', 'input': {}},
                            {'type': 'tool_result', 'callId': 'c2', 'status': 'completed', 'result': 'WRONG'},
                            {'type': 'tool_result', 'callId': 'c1', 'status': 'completed', 'result': 'david_ask: ok\nanswer'},
                            {'type': 'final', 'text': 'something else'})
        self.assertEqual(self.cli.parse_stream(lines, 'david_ask'), ('david_ask: ok\nanswer', 'completed'))

    def test_no_call_is_reported_with_what_the_agent_said(self):
        text, why = self.cli.parse_stream(self.stream({'type': 'final', 'text': 'I did it myself'}, ), 'david_run')
        self.assertIsNone(text)
        self.assertIn('never called david_run', why)
        self.assertIn('I did it myself', why)
        self.assertEqual(self.cli.parse_stream(['not json', ''], 'david_run')[0], None)

    def test_exit_codes_follow_the_report_status(self):
        e = self.cli.exit_code
        self.assertEqual(e('david_run', 'david_run: ok\n...', 'completed'), 0)
        self.assertEqual(e('david_run', 'david_run: awaiting_human\n', 'completed'), 10)
        self.assertEqual(e('david_run', 'david_run: failed\n', 'completed'), 11)
        self.assertEqual(e('david_ask', 'david_ask: ok', 'completed'), 0)
        self.assertEqual(e('david_run', 'david_run: error', 'completed'), 1)
        self.assertEqual(e('david_run', 'Error: boom', 'failed'), 1)

    def test_the_prompt_carries_the_arguments_as_json(self):
        p = self.cli.build_prompt('david_run', {'task': 'say "hi" — é', 'cwd': '/r'})
        self.assertIn('david_run', p)
        self.assertIn(json.dumps({'task': 'say "hi" — é', 'cwd': '/r'}, ensure_ascii=False), p)
        self.assertIn('exactly once', p)

    def test_missing_runtime_is_a_clear_exit_2(self):
        with mock.patch.object(self.cli, 'DSH', '/nonexistent/dsh'):
            self.assertEqual(self.cli.call('david_ask', {'question': 'q'}, 5), 2)


if __name__ == '__main__':
    unittest.main()
