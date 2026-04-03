import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from './toast-context';

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes

export interface UpdateState {
  sha: string;
  remoteSha: string;
  updateAvailable: boolean;
  checkedAt: string;
}

export function useUpdateCheck() {
  const toast = useToast();
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const notifiedRef = useRef(false);

  const query = useQuery({
    queryKey: ['version'],
    queryFn: () => api.getVersion(),
    refetchInterval: CHECK_INTERVAL_MS,
    refetchOnMount: true,
  });

  useEffect(() => {
    if (query.data?.updateAvailable && !notifiedRef.current) {
      notifiedRef.current = true;
      toast.info(`Update available: ${query.data.sha} → ${query.data.remoteSha}`);
    }
    if (query.data && !query.data.updateAvailable) {
      notifiedRef.current = false;
    }
  }, [query.data, toast]);

  return {
    ...query,
    showUpdateModal,
    openUpdateModal: () => setShowUpdateModal(true),
    closeUpdateModal: () => setShowUpdateModal(false),
  };
}

export function getStaticVersion(): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="fleet-version"]');
  return meta?.content || 'unknown';
}
