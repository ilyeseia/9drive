import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { providersApi, type RoutingMode, type S3ConnectInput } from '../../api/endpoints/providers';
import { useServices } from '../../app/services';

export function useAccounts() {
  const { client } = useServices();
  return useQuery({ queryKey: ['storage', 'accounts'], queryFn: ({ signal }) => providersApi.accounts(client, signal) });
}

/** Display names come from the server catalog; the list is static, so it is cached for the session. */
export function useCatalog() {
  const { client } = useServices();
  return useQuery({ queryKey: ['storage', 'catalog'], queryFn: ({ signal }) => providersApi.catalog(client, signal), staleTime: Infinity });
}

export function useRoutingPolicy() {
  const { client } = useServices();
  return useQuery({ queryKey: ['storage', 'routing'], queryFn: ({ signal }) => providersApi.routingPolicy(client, signal) });
}

export function useStorageActions() {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['storage'] });
  return {
    checkHealth: useMutation({ mutationFn: (id: string) => providersApi.checkHealth(client, id), onSettled: refresh }),
    refreshQuota: useMutation({ mutationFn: (id: string) => providersApi.refreshQuota(client, id), onSettled: refresh }),
    setRouting: useMutation({
      mutationFn: (v: { id: string; enabled: boolean }) => providersApi.setRoutingEnabled(client, v.id, v.enabled),
      onSettled: refresh,
    }),
    disconnect: useMutation({
      mutationFn: (id: string) => providersApi.disconnect(client, id),
      onSettled: () => Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['files'] })]),
    }),
    connectUrl: useMutation({ mutationFn: (provider: string) => providersApi.connectUrl(client, provider).then((url) => ({ url })) }),
    connectS3: useMutation({ mutationFn: (input: S3ConnectInput) => providersApi.connectS3(client, input), onSuccess: refresh }),
    updatePolicy: useMutation({
      mutationFn: (patch: { mode?: RoutingMode; priorityAccountIds?: string[] }) => providersApi.updateRoutingPolicy(client, patch),
      onSuccess: (policy) => queryClient.setQueryData(['storage', 'routing'], policy),
    }),
    preview: useMutation({ mutationFn: (v: { bytes: number; fileType?: string }) => providersApi.previewRouting(client, v) }),
  };
}
