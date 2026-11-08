# Calendar tilt release and recovery

## Verified Production baseline before this change

- Project: `test-project` (team `fff-7e58`)
- Production Deployment ID: `dpl_DHFcwjjbrfdr7iobd273WZSRDPSj`
- Source commit: `a699406717e644460814964e455c83a3415c8664`
- State: `READY`, target `production`
- Official domain: `daysync-app.vercel.app`

This is a frontend-only change. It does not modify the Worker, D1 schema, API behavior, or user data. The legacy `daysync-card-3d-tilt` local-storage key is ignored; it is neither read nor written. There is no user-facing tilt switch.

## Targeted recovery: disable calendar-cell 3D only

If calendar-cell tilt causes a visual or interaction regression, keep the profile switch removed and preserve all calendar operations:

1. In `frontend/app.js`, remove `calendar-tilt-card` from the class assigned by `renderMonthCalendar` (retain `day calendar-day`).
2. In `frontend/card-tilt.mjs`, remove `.calendar-tilt-card` from the delegated target selector so pointer tracking remains available to `.interactive-card` group cards only.
3. In `frontend/style.css`, remove the `.calendar-tilt-card` hover, focus, transition, and reduced-motion selectors. Keep the `.interactive-card` rules and calendar selected/today styles.
4. Run Frontend tests and Browser E2E, open a Preview, then merge through the protected GitHub flow to let Vercel deploy the hotfix.

This disables only the new calendar-cell 3D effect. Date selection, event display, editing, deletion, and the existing interactive group-card effect remain in place. No Worker or D1 rollback is needed.

## Full frontend recovery

If a broader Production regression requires immediate recovery, use Vercel's normal rollback/promote flow to restore the verified baseline Deployment ID above. This reverts the entire frontend to the pre-change deployment, so use the targeted recovery hotfix when only calendar-cell tilt is affected. Keep the current deployment available for diagnosis; do not remove deployments or user data.
