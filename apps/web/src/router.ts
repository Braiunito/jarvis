/**
 * Un router mínimo sobre la History API.
 *
 * La URL es la identidad navegable: workspace, run o terminal activos están en ella, así que
 * recargar, compartir un enlace o volver atrás llevan exactamente al mismo sitio. No hace falta
 * una dependencia para eso.
 */
import { useCallback, useEffect, useState } from 'react';

export interface Route {
  path: string;
  segments: string[];
  query: URLSearchParams;
}

const read = (): Route => {
  const url = new URL(window.location.href);
  return {
    path: url.pathname,
    segments: url.pathname.split('/').filter(Boolean),
    query: url.searchParams,
  };
};

export function useRoute(): Route & { navigate: (to: string, options?: { replace?: boolean }) => void } {
  const [route, setRoute] = useState<Route>(read);

  useEffect(() => {
    const onPop = (): void => setRoute(read());
    window.addEventListener('popstate', onPop);
    window.addEventListener('jarvis:navigate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('jarvis:navigate', onPop);
    };
  }, []);

  const navigate = useCallback((to: string, options: { replace?: boolean } = {}): void => {
    if (options.replace) window.history.replaceState({}, '', to);
    else window.history.pushState({}, '', to);
    window.dispatchEvent(new Event('jarvis:navigate'));
  }, []);

  return { ...route, navigate };
}

export const navigate = (to: string): void => {
  window.history.pushState({}, '', to);
  window.dispatchEvent(new Event('jarvis:navigate'));
};
