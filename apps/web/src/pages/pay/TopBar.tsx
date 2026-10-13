/**
 * The bill's top bar after verification: the practice's monogram and name, "Secure bill for
 * Maria D. · verified", and (on the right) the language controls.
 */
import type { ReactNode } from 'react';
import { useI18n } from './i18n';

interface Props {
  practiceName: string;
  /** "Maria D." */
  patientName: string;
  children?: ReactNode;
}

export function TopBar({ practiceName, patientName, children }: Props) {
  const { t } = useI18n();
  return (
    <header className="pay-topbar">
      <div className="pay-topbar-inner">
        <div className="pay-topbar-brand">
          <span className="pay-monogram" aria-hidden="true">
            {practiceName.trim().charAt(0).toUpperCase()}
          </span>
          <div>
            <div className="pay-topbar-name">{practiceName}</div>
            <div className="pay-topbar-sub">{t('topSecure', { name: patientName })}</div>
          </div>
        </div>
        {children}
      </div>
    </header>
  );
}
