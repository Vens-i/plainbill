// AG Grid modules + license must be set up before any grid renders.
import './agGrid';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import { AppShell } from './components/AppShell';
import { Dashboard } from './pages/Dashboard';
import { Placeholder } from './pages/Placeholder';

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <Navigate to="/dashboard" replace /> },
      { path: '/dashboard', element: <Dashboard /> },
      { path: '/intake', element: <Placeholder title="Intake" phase="Phase 2" /> },
      { path: '/invoices', element: <Placeholder title="Invoices" phase="a later phase" /> },
      { path: '/patients', element: <Placeholder title="Patients" phase="a later phase" /> },
      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
