/**
 * AG Grid Enterprise setup, run once at startup (imported first by main.tsx).
 *
 * - Registers every Enterprise module, with AG Charts Enterprise for integrated charts and
 *   sparklines.
 * - Applies the license key from VITE_AG_GRID_LICENSE_KEY. Without a valid key the grid runs in
 *   trial mode: AG Grid prints a license notice to the console, and shows a watermark on
 *   non-localhost hosts. Run `pnpm check:license` to validate a key without opening a browser.
 */
import { ModuleRegistry } from 'ag-grid-community';
import { AllEnterpriseModule, LicenseManager } from 'ag-grid-enterprise';
import { AgChartsEnterpriseModule } from 'ag-charts-enterprise';
import {
  AllCommunityModule as AllChartsCommunityModule,
  ModuleRegistry as ChartsModuleRegistry,
} from 'ag-charts-community';

ModuleRegistry.registerModules([AllEnterpriseModule.with(AgChartsEnterpriseModule)]);
// Standalone AG Charts (side panel) only use community series.
ChartsModuleRegistry.registerModules([AllChartsCommunityModule]);

const licenseKey = import.meta.env.VITE_AG_GRID_LICENSE_KEY?.trim();

export type LicenseStatus =
  | { state: 'missing' }
  | { state: 'valid'; expiry: string; trial: boolean }
  | { state: 'invalid'; reason: string };

function checkLicense(key: string | undefined): LicenseStatus {
  if (!key) return { state: 'missing' };
  const details = LicenseManager.getLicenseDetails(key);
  if (details.valid) {
    // Integrated charts are registered, so AG Grid requires a Grid + Charts ("BOTH") key.
    if (details.suppliedLicenseType && details.suppliedLicenseType !== 'BOTH') {
      return {
        state: 'invalid',
        reason: `key is for ${details.suppliedLicenseType}, integrated charts need Grid + Charts`,
      };
    }
    return { state: 'valid', expiry: details.expiry ?? 'unknown', trial: Boolean(details.isTrial) };
  }
  if (details.incorrectLicenseType) {
    return {
      state: 'invalid',
      reason: `license type "${details.suppliedLicenseType ?? 'unknown'}" is not accepted (needs ${details.currentLicenseType})`,
    };
  }
  return { state: 'invalid', reason: 'not a valid AG Grid Enterprise key' };
}

if (licenseKey) LicenseManager.setLicenseKey(licenseKey);

export const licenseStatus: LicenseStatus = checkLicense(licenseKey);

const message =
  licenseStatus.state === 'valid'
    ? `[Plainbill] AG Grid Enterprise license accepted (expires ${licenseStatus.expiry}${licenseStatus.trial ? ', trial' : ''}).`
    : licenseStatus.state === 'missing'
      ? '[Plainbill] VITE_AG_GRID_LICENSE_KEY is not set — AG Grid Enterprise is running in trial mode.'
      : `[Plainbill] AG Grid Enterprise license rejected: ${licenseStatus.reason}. Running in trial mode.`;
(licenseStatus.state === 'valid' ? console.info : console.warn)(message);
