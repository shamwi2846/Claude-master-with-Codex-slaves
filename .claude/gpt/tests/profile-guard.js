// Every check script loads this first. The checks create and delete fixed folders under the home folder and
// reset the setup's state, so they may only run inside run.js's throwaway profile (where the home folder IS
// that profile). A script started directly (node t_x.js) hands itself to run.js instead of touching the
// user's real home and setup state.
const path = require('path'), os = require('os');
const home = path.resolve(os.homedir()), profile = process.env.GPT_TEST_PROFILE;
if (!profile || path.resolve(profile).toLowerCase() !== home.toLowerCase() || !/^\.gpt-test-profile-\d+$/.test(path.basename(home))) {
  const name = path.basename(require.main ? require.main.filename : process.argv[1] || '');
  console.error(`(${name} runs only inside the test profile: running it through tests/run.js)`);
  const r = require('child_process').spawnSync(process.execPath, [path.join(__dirname, 'run.js'), name], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}
