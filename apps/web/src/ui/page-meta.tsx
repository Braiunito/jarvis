/**
 * El título de la página vive en la cabecera del armazón, no dentro de cada pantalla.
 *
 * Como la cabecera es común y las pantallas van y vienen, cada una declara qué se debe leer ahí
 * arriba con `usePageMeta`. Son cadenas, no JSX, para que el efecto dependa de valores y no de
 * un elemento nuevo en cada render.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface PageMeta {
  title: string;
  subtitle?: string;
  /** Migas: de dónde viene esta pantalla, cuando venir de algún sitio significa algo. */
  parent?: { label: string; to: string };
}

interface Store {
  meta: PageMeta;
  set: (meta: PageMeta) => void;
}

const PageMetaContext = createContext<Store | null>(null);

export function PageMetaProvider({ children }: { children: ReactNode }): ReactNode {
  const [meta, setMeta] = useState<PageMeta>({ title: 'Jarvis' });
  const value = useMemo<Store>(() => ({ meta, set: setMeta }), [meta]);
  return <PageMetaContext.Provider value={value}>{children}</PageMetaContext.Provider>;
}

export function usePageMetaValue(): PageMeta {
  return useContext(PageMetaContext)?.meta ?? { title: 'Jarvis' };
}

export function usePageMeta(meta: PageMeta): void {
  const store = useContext(PageMetaContext);
  const { title, subtitle, parent } = meta;
  useEffect(() => {
    store?.set({ title, ...(subtitle ? { subtitle } : {}), ...(parent ? { parent } : {}) });
    document.title = `${title} · Jarvis`;
    // Las dependencias son los valores, no el objeto: si no, esto se dispararía en cada render.
  }, [store, title, subtitle, parent?.label, parent?.to]);
}
