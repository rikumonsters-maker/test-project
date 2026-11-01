import {execFileSync,spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {readFileSync,readdirSync} from 'node:fs';

// Only the local test configuration is permitted here. The fake D1 ID and
// --local/--persist-to guard against accidental production access.
const backend=resolve(import.meta.dirname,'../../backend');
const wrangler=resolve(backend,'node_modules/wrangler/bin/wrangler.js');
const persist=resolve(import.meta.dirname,'../test-results/local-worker-db');
const config='wrangler.rc-test.jsonc';
const db='daysync-rc-local';
const configText=readFileSync(resolve(backend,config),'utf8');
const files=readdirSync(resolve(backend,'migrations')).filter(name=>name.endsWith('.sql')).sort();
const allowed=['0001_shared_calendar.sql','0002_member_calendar_entries.sql','0003_auth_users.sql',
  '0004_profile_push.sql','0005_push_delivery_queue.sql','0006_ephemeral_status.sql',
  '0007_group_availability_wishes.sql','0008_group_images_and_tentative_events.sql',
  '0009_group_preset_icons.sql','0010_group_icon_ids.sql','0012_personal_event_sync.sql',
  '0013_push_reminders.sql','0014_in_app_notifications.sql','0014a_group_leave_guard.sql',
  '0015_group_departures.sql','0016_common_availability_coverage.sql','0017_group_scheduling.sql',
  '0018_group_closure.sql','0019_named_busy_sharing.sql','0020_named_busy_notice.sql'].sort();
if(!configText.includes('00000000-0000-0000-0000-000000000001') ||
   !configText.includes('"name": "daysync-rc-test"') ||
   !configText.includes('"database_name": "daysync-rc-local"') ||
   !configText.includes('"remote": false') ||
   !configText.includes('"migrations_dir": "migrations"') ||
   JSON.stringify(files)!==JSON.stringify(allowed)) {
  throw new Error('Local D1 test configuration or migration allowlist changed; aborting.');
}
const apply=['d1','migrations','apply',db,'--local','--persist-to',persist,'--config',config];
execFileSync(process.execPath,[wrangler,...apply],{cwd:backend,stdio:'pipe',timeout:120000});
const child=spawn(process.execPath,[wrangler,'dev','--local','--persist-to',persist,'--config',config,'--port','8787'],
  {cwd:backend,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{child.kill(signal);process.exit(0);});
child.on('exit',code=>process.exit(code||0));
