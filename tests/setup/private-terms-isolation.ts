import { ABSENT_PRIVATE_TERMS_FILE } from '../helpers/private-terms-env.ts';

// Guards load a private term file from the operator's machine, and the local gate exports
// WHATSOUP_REQUIRE_PRIVATE_TERMS=1. The suite must behave the same on every host: point the
// loader at a path that cannot exist (the inline fallback rules then run, as in CI) and clear
// both require switches. Term tests set WHATSOUP_PRIVATE_TERMS_FILE to the synthetic fixture.
process.env['WHATSOUP_PRIVATE_TERMS_FILE'] = ABSENT_PRIVATE_TERMS_FILE;
// The --tree baseline is private too (~/.config/whatsoup/boundary-baseline.json): point it at an
// absent file next to the absent term file; tree tests name their own baseline file.
process.env['WHATSOUP_BOUNDARY_BASELINE_FILE'] = ABSENT_PRIVATE_TERMS_FILE.replace(/private-terms\.json$/, 'boundary-baseline.json');
delete process.env['WHATSOUP_REQUIRE_PRIVATE_TERMS'];
delete process.env['WHATSOUP_REQUIRE_GITLEAKS'];
