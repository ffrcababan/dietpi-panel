'use client';

import React, { createContext, useContext } from 'react';
import useSWR from 'swr';
import { apiFetcher } from '@/lib/client-api';
import type { UserRole } from '@/lib/validation';

export interface MeData {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: UserRole;
  csrfToken: string;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  baseDomain: string;
  agentConnected: boolean;
}

interface PanelContextValue {
  me: MeData | undefined;
  isLoading: boolean;
  refreshMe: (nextData?: MeData) => Promise<MeData | undefined>;
}

const PanelContext = createContext<PanelContextValue>({
  me: undefined,
  isLoading: true,
  refreshMe: async () => undefined,
});

export function PanelProvider({
  initialMe,
  children,
}: {
  initialMe?: MeData;
  children: React.ReactNode;
}) {
  const { data, isLoading, mutate } = useSWR<MeData>('/api/auth/me', apiFetcher, {
    fallbackData: initialMe,
    refreshInterval: 10_000,
    revalidateOnMount: true,
    revalidateOnFocus: true,
  });

  return (
    <PanelContext.Provider
      value={{
        me: data,
        isLoading,
        refreshMe: (nextData?: MeData) =>
          nextData ? mutate(nextData, { revalidate: true }) : mutate(),
      }}
    >
      {children}
    </PanelContext.Provider>
  );
}

export function usePanel(): PanelContextValue {
  return useContext(PanelContext);
}
