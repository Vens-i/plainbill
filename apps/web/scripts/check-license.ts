/**
 * Check VITE_AG_GRID_LICENSE_KEY against ag-grid-enterprise without opening a browser.
 * Prints the verdict and license metadata — never the key itself.
 *
 *   pnpm check:license
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LicenseManager } from 'ag-grid-enterprise';

const envFile = resolve(import.meta.dirname, '..', '..', '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const key = process.env.VITE_AG_GRID_LICENSE_KEY?.trim();
if (!key) {
  console.log(
    'VITE_AG_GRID_LICENSE_KEY is not set in .env — AG Grid Enterprise will run in trial mode.',
  );
  process.exit(1);
}

const d = LicenseManager.getLicenseDetails(key);
const bracketed = (key.match(/\[(.*?)\]/g) ?? []).map((m) => m.slice(1, -1));
// Human-readable keys say which product they cover, e.g. "This_key_works_with_{AG_Grid}_Enterprise".
const product = /works_with_\{([^}]*)\}/.exec(key)?.[1]?.replaceAll('_', ' ');
console.log(
  `Key length: ${key.length} characters; bracketed tags: ${bracketed.join(', ') || 'none'}`,
);
console.log(`Product named in the key: ${product ?? '(not stated)'}`);
console.log(`Supplied license type: ${d.suppliedLicenseType ?? '(none — legacy/v2 key)'}`);

if (!d.valid) {
  console.log(
    d.incorrectLicenseType
      ? `✗ Rejected: license type "${d.suppliedLicenseType ?? 'unknown'}" is not accepted by ag-grid-enterprise (accepts GRID or BOTH).`
      : '✗ Rejected: not a valid AG Grid Enterprise key (signature check failed).',
  );
  process.exit(1);
}

console.log(
  `Expiry: ${d.expiry}${d.expired ? ' (EXPIRED for this AG Grid version)' : ''}${d.isTrial ? ' · trial key' : ''}`,
);
// The dashboard registers integrated charts (AllEnterpriseModule.with(AgChartsEnterpriseModule)),
// which makes AG Grid require a Grid + Charts ("BOTH") key for v3 keys.
const okWithCharts = !d.suppliedLicenseType || d.suppliedLicenseType === 'BOTH';
console.log(
  okWithCharts
    ? '✓ Accepted by ag-grid-enterprise, including integrated charts.'
    : '△ Valid for AG Grid only. Integrated charts are registered, so this key will be rejected at runtime unless it covers Grid + Charts.',
);
process.exit(okWithCharts && !d.expired ? 0 : 1);
