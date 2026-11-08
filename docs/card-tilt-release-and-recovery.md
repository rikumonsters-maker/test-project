# Card tilt release and recovery

## Pre-change Production baseline

- Vercel project: `test-project`
- Production Deployment ID: `dpl_HYR7GNqBuRNNnRt3uXjpkWWRSUxH`
- Production source commit: `405ccf217e1666086554237bebbfb330200321dc`
- Verified state: `READY`, target `production`, official alias `daysync-app.vercel.app`

This change is frontend-only. It does not alter the Worker, D1 schema, API behavior, or user data.

## Disable 3D tilt for one browser

Open **プロフィール → 表示設定** and turn off **カードの3Dチルト**. The preference is stored in that browser's local storage under `daysync-card-3d-tilt`; no server request is made. Turning it off removes card rotation, lift, and pointer-follow highlight. Calendar content, selection, editing, and buttons continue to work. The 2D focus outline remains available to keyboard users.

If local storage is unavailable, the UI reports that the choice may not persist after reload; the feature remains enabled by default in that browser session.

## Global release recovery

If the Production release has a broader regression, use Vercel's normal rollback/promote flow to restore the verified baseline Deployment ID above, whose source commit was `405ccf217e1666086554237bebbfb330200321dc`. This visual-only change needs no Worker rollback or D1 action. Keep the current release available for diagnosis and do not remove deployments or user data.
