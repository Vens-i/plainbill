import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';

// Staff pages (AG Grid) and the patient page load separately, so patients never download the
// grid bundle.
// Shown for the moment a lazy route loads on first paint.
const Loading = () => null;

const router = createBrowserRouter([
  {
    path: '/pay/:token',
    HydrateFallback: Loading,
    lazy: async () => ({ Component: (await import('./pages/pay/PayPage')).PayPage }),
  },
  {
    HydrateFallback: Loading,
    lazy: async () => ({ Component: (await import('./components/AppShell')).AppShell }),
    children: [
      { path: '/', element: <Navigate to="/dashboard" replace /> },
      {
        path: '/dashboard',
        lazy: async () => ({ Component: (await import('./pages/Dashboard')).Dashboard }),
      },
      {
        path: '/intake',
        lazy: async () => ({ Component: (await import('./pages/Intake')).Intake }),
      },
      {
        path: '/email-preview/:id',
        lazy: async () => ({ Component: (await import('./pages/EmailPreview')).EmailPreview }),
      },
      {
        path: '/invoices',
        lazy: async () => {
          const { Placeholder } = await import('./pages/Placeholder');
          return { element: <Placeholder title="Invoices" phase="a later phase" /> };
        },
      },
      {
        path: '/patients',
        lazy: async () => {
          const { Placeholder } = await import('./pages/Placeholder');
          return { element: <Placeholder title="Patients" phase="a later phase" /> };
        },
      },
      { path: '*', element: <Navigate to="/dashboard" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
