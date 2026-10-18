import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sharingApi } from '../../api/endpoints/sharing';
import { useServices } from '../../app/services';

export function useShares() {
  const { client } = useServices();
  return useQuery({ queryKey: ['shares'], queryFn: ({ signal }) => sharingApi.list(client, signal) });
}

export function useShareActions() {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['shares'] });
  return {
    create: useMutation({ mutationFn: (fileId: string) => sharingApi.create(client, fileId), onSuccess: refresh }),
    revokeAll: useMutation({ mutationFn: (fileId: string) => sharingApi.revokeAll(client, fileId), onSuccess: refresh }),
  };
}
