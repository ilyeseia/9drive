import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { filesApi, foldersApi, type FileKind, type FileSort, type FolderItem } from '../../api/endpoints/files';
import { useServices } from '../../app/services';

export interface FileFilters {
  folderId: string | null;
  q: string;
  kind?: FileKind;
  sort: FileSort;
  order: 'asc' | 'desc';
}

/**
 * The server's page cursor encodes only [createdAt, id], so it is valid only when sorting by date. For name/size
 * sorting the app fetches one bounded page (200) and tells the user when results were cut off.
 */
export const isCursorSort = (sort: FileSort): boolean => sort === 'createdAt';

export function useFiles(filters: FileFilters) {
  const { client } = useServices();
  const paged = isCursorSort(filters.sort);
  const query = useInfiniteQuery({
    queryKey: ['files', 'list', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => filesApi.list(client, { ...filters, cursor: pageParam, limit: paged ? 50 : 200 }, signal),
    getNextPageParam: (last) => (paged ? last.nextCursor : undefined),
  });
  const files = query.data?.pages.flatMap((p) => p.files) ?? [];
  const truncated = !paged && (query.data?.pages[0]?.nextCursor ?? undefined) !== undefined;
  return { ...query, files, truncated };
}

export function useFolders(parentId: string | null) {
  const { client } = useServices();
  return useQuery({ queryKey: ['folders', 'children', parentId], queryFn: ({ signal }) => foldersApi.list(client, parentId, signal) });
}

export function useAllFolders(enabled = true) {
  const { client } = useServices();
  return useQuery({ queryKey: ['folders', 'all'], queryFn: ({ signal }) => foldersApi.listAll(client, signal), enabled });
}

export function useFileDetail(id: string) {
  const { client } = useServices();
  return useQuery({ queryKey: ['files', 'detail', id], queryFn: ({ signal }) => filesApi.get(client, id, signal) });
}

function invalidate(queryClient: QueryClient, what: ('files' | 'folders')[]) {
  return Promise.all(what.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
}

/** Mutations. The server's answer decides the outcome; lists are refetched afterwards, never patched optimistically. */
export function useFileActions() {
  const { client } = useServices();
  const queryClient = useQueryClient();
  const done = (what: ('files' | 'folders')[]) => () => invalidate(queryClient, what);
  return {
    rename: useMutation({
      mutationFn: (v: { id: string; name: string }) => filesApi.rename(client, v.id, v.name),
      onSuccess: done(['files']),
    }),
    move: useMutation({
      mutationFn: async (v: { ids: string[]; folderId: string | null }) => {
        if (v.ids.length === 1) await filesApi.move(client, v.ids[0]!, v.folderId);
        else await filesApi.moveMany(client, v.ids, v.folderId);
      },
      onSuccess: done(['files']),
    }),
    trash: useMutation({
      mutationFn: async (ids: string[]) => {
        if (ids.length === 1) await filesApi.trash(client, ids[0]!);
        else await filesApi.trashMany(client, ids);
      },
      onSuccess: done(['files']),
    }),
    copy: useMutation({
      mutationFn: (v: { id: string; folderId: string | null }) => filesApi.copy(client, v.id, v.folderId),
      onSuccess: done(['files']),
    }),
    createFolder: useMutation({
      mutationFn: (v: { name: string; parentId: string | null }) => foldersApi.create(client, v.name, v.parentId),
      onSuccess: done(['folders']),
    }),
    renameFolder: useMutation({
      mutationFn: (v: { id: string; name: string }) => foldersApi.rename(client, v.id, v.name),
      onSuccess: done(['folders']),
    }),
    deleteFolder: useMutation({ mutationFn: (id: string) => foldersApi.remove(client, id), onSuccess: done(['folders', 'files']) }),
  };
}

/** Builds "Parent / Child" labels for the folder picker from the flat list. Cycles and orphans cannot loop forever. */
export function folderPaths(folders: FolderItem[]): { id: string; label: string }[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const label = (folder: FolderItem): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let current: FolderItem | undefined = folder;
    while (current && !seen.has(current.id) && parts.length < 32) {
      seen.add(current.id);
      parts.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return parts.join(' / ');
  };
  return folders.map((f) => ({ id: f.id, label: label(f) })).sort((a, b) => a.label.localeCompare(b.label));
}
