// AG Grid modules + license must be set up before any staff grid renders.
import '../agGrid';
import '../components.css';
import { NavLink, Outlet, useOutletContext } from 'react-router';
import { useEffect, useState } from 'react';
import type { PracticeInfo } from '@plainbill/api/contract';
import { api } from '../lib/api';
import { Toaster } from './Toast';

export interface ShellContext {
  practice: PracticeInfo | null;
  search: string;
  setSearch: (value: string) => void;
}

export function useShell(): ShellContext {
  return useOutletContext<ShellContext>();
}

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/intake', label: 'Intake' },
  { to: '/invoices', label: 'Invoices' },
  { to: '/patients', label: 'Patients' },
];

export function AppShell() {
  const [practice, setPractice] = useState<PracticeInfo | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.practice().then(setPractice, () => setPractice(null));
  }, []);

  return (
    <>
      <header className="topbar">
        <a className="brand" href="/dashboard" aria-label="Plainbill home">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span className="brand-name">Plainbill</span>
          <span className="brand-practice">{practice?.name ?? 'Harborview Family Medicine'}</span>
        </a>
        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? 'active' : '')}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-spacer" />
        <label className="visually-hidden" htmlFor="global-search">
          Search patient, claim, or invoice
        </label>
        <input
          id="global-search"
          className="search"
          type="search"
          placeholder="Search patient, claim, or invoice"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div
          className="avatar"
          title={practice?.user.name ?? 'Rosa M.'}
          aria-label={`Signed in as ${practice?.user.name ?? 'Rosa M.'}`}
        >
          {practice?.user.initials ?? 'RM'}
        </div>
      </header>
      <Outlet context={{ practice, search, setSearch } satisfies ShellContext} />
      <Toaster />
    </>
  );
}
