import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, I18nManager, Pressable, RefreshControl, ScrollView, TextInput, View } from 'react-native';
import { bytesToNumber } from '../../api/schemas';
import type { FileItem, FileKind, FileSort, FolderItem } from '../../api/endpoints/files';
import { useServices, useTransfers } from '../../app/services';
import { isolate, formatBytes, formatDate } from '../../i18n/format';
import { describeErrorDetail } from '../../core/errorDetail';
import { useI18n } from '../../i18n/I18nProvider';
import type { MessageKey } from '../../i18n/messages';
import { MIN_TARGET, elevation, radius, spacing, useTheme } from '../../theme/theme';
import { pickDocuments, pickPhotos, takePhoto, type PickResult } from '../../transfers/device';
import { fileFamily } from '../../transfers/names';
import { AppText, Button, Card, Screen, StateView } from '../../ui/components';
import { ActionSheet, Chip, IconTile, PromptModal, ScreenHeader, type Tone } from '../../ui/extra';
import { Icon, type IconName } from '../../ui/Icon';
import { FreshnessNote } from '../../ui/Offline';
import type { FilesStackParamList } from '../../navigation/FilesStack';
import { FolderPicker } from './FolderPicker';
import { useFileActions, useFiles, useFolders } from './queries';

type Nav = NativeStackNavigationProp<FilesStackParamList, 'FilesList'>;

const SORTS: { sort: FileSort; key: MessageKey }[] = [
  { sort: 'createdAt', key: 'sortDate' },
  { sort: 'name', key: 'sortName' },
  { sort: 'size', key: 'sortSize' },
];
const KINDS: { kind: FileKind | undefined; key: MessageKey }[] = [
  { kind: undefined, key: 'kindAll' },
  { kind: 'image', key: 'kindImage' },
  { kind: 'video', key: 'kindVideo' },
  { kind: 'pdf', key: 'kindPdf' },
  { kind: 'doc', key: 'kindDoc' },
  { kind: 'archive', key: 'kindArchive' },
];

type Row = { type: 'folder'; folder: FolderItem } | { type: 'file'; file: FileItem };

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function FilesScreen() {
  const { t, describeError, locale } = useI18n();
  const { colors } = useTheme();
  const navigation = useNavigation<Nav>();
  const { transfers } = useServices();
  const transferItems = useTransfers();
  const actions = useFileActions();

  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<FileSort>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [kind, setKind] = useState<FileKind | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const folderId = path.length > 0 ? (path[path.length - 1]?.id ?? null) : null;
  const q = useDebounced(search, 350);
  const filters = useMemo(() => ({ folderId, q, kind, sort, order }), [folderId, q, kind, sort, order]);
  const files = useFiles(filters);
  const folders = useFolders(folderId);
  const selecting = selected.size > 0;

  const activeTransfers = transferItems.filter((i) => i.status === 'active' || i.status === 'queued' || i.status === 'paused').length;
  const showFolders = q.trim() === '' && !kind;

  const rows: Row[] = useMemo(() => {
    const list: Row[] = [];
    if (showFolders) for (const folder of folders.data ?? []) list.push({ type: 'folder', folder });
    for (const file of files.files) list.push({ type: 'file', file });
    return list;
  }, [showFolders, folders.data, files.files]);

  const refresh = useCallback(() => {
    void files.refetch();
    void folders.refetch();
  }, [files, folders]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addFrom(pick: () => Promise<PickResult>) {
    setNotice(null);
    try {
      const result = await pick();
      if (result.kind === 'denied') setNotice(t('cameraDenied'));
      else if (result.kind === 'ok' && result.files.length > 0) {
        transfers.enqueueUploads(result.files, folderId);
        navigation.navigate('Transfers');
      }
    } catch (error) {
      setNotice(describeError(error));
    }
  }

  function confirmTrash() {
    const ids = [...selected];
    Alert.alert(t('trashConfirmTitle'), t('trashConfirmBody', { count: ids.length }), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('moveToTrash'),
        style: 'destructive',
        onPress: () => {
          actions.trash.mutate(ids, {
            onSuccess: () => setSelected(new Set()),
            onError: (error) => setNotice(describeError(error)),
          });
        },
      },
    ]);
  }

  const header = (
    <View style={{ gap: spacing.md, paddingBottom: spacing.sm }}>
      <ScreenHeader
        title={t('filesTitle')}
        right={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${t('transfers')}${activeTransfers > 0 ? `, ${activeTransfers}` : ''}`}
            onPress={() => navigation.navigate('Transfers')}
            style={{
              minHeight: MIN_TARGET,
              paddingHorizontal: spacing.md,
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.xs,
              borderRadius: radius.pill,
              backgroundColor: activeTransfers > 0 ? colors.primary : colors.surfaceAlt,
            }}
          >
            <Icon name="upload" size={18} color={activeTransfers > 0 ? colors.onPrimary : colors.primary} />
            <AppText variant="label" style={{ color: activeTransfers > 0 ? colors.onPrimary : colors.primary }}>
              {t('transfers')}
              {activeTransfers > 0 ? ` (${activeTransfers})` : ''}
            </AppText>
          </Pressable>
        }
      />

      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Chip label={t('sharedLinks')} onPress={() => navigation.navigate('SharedLinks')} />
      </View>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          paddingHorizontal: spacing.md,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.pill,
          backgroundColor: colors.surface,
        }}
      >
        <Icon name="search" size={18} color={colors.textMuted} />
        <TextInput
          accessibilityLabel={t('searchFiles')}
          placeholder={t('searchFiles')}
          placeholderTextColor={colors.textMuted}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          maxFontSizeMultiplier={1.6}
          style={{ flex: 1, minHeight: MIN_TARGET, color: colors.text, fontSize: 16 }}
        />
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
        {SORTS.map((s) => (
          <Chip
            key={s.sort}
            label={t(s.key)}
            selected={sort === s.sort}
            onPress={() =>
              sort === s.sort
                ? setOrder(order === 'asc' ? 'desc' : 'asc')
                : (setSort(s.sort), setOrder(s.sort === 'createdAt' ? 'desc' : 'asc'))
            }
          />
        ))}
        <Chip label={t(order === 'asc' ? 'orderAsc' : 'orderDesc')} onPress={() => setOrder(order === 'asc' ? 'desc' : 'asc')} />
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
        {KINDS.map((k) => (
          <Chip key={k.key} label={t(k.key)} selected={kind === k.kind} onPress={() => setKind(k.kind)} />
        ))}
      </ScrollView>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.xs, alignItems: 'center' }}
        accessibilityLabel={t('allFiles')}
      >
        <Pressable accessibilityRole="button" onPress={() => setPath([])} style={{ minHeight: 40, justifyContent: 'center' }}>
          <AppText style={{ color: path.length === 0 ? colors.text : colors.primary, fontWeight: '600' }}>{t('allFiles')}</AppText>
        </Pressable>
        {path.map((entry, index) => (
          <View key={entry.id} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
            <AppText muted>/</AppText>
            <Pressable
              accessibilityRole="button"
              onPress={() => setPath(path.slice(0, index + 1))}
              style={{ minHeight: 40, justifyContent: 'center' }}
            >
              <AppText style={{ color: index === path.length - 1 ? colors.text : colors.primary, fontWeight: '600' }}>
                {isolate(entry.name)}
              </AppText>
            </Pressable>
          </View>
        ))}
      </ScrollView>

      {notice ? (
        <Card style={{ borderColor: colors.warning }}>
          <AppText accessibilityRole="alert" style={{ color: colors.warning }}>
            {notice}
          </AppText>
        </Card>
      ) : null}
      <FreshnessNote updatedAt={files.dataUpdatedAt} stale={files.isError || files.fetchStatus === 'paused'} />
      {files.truncated ? (
        <AppText variant="caption" muted>
          {t('resultsTruncated')}
        </AppText>
      ) : null}
    </View>
  );

  return (
    <Screen padded={false}>
      {selecting ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: spacing.sm,
            padding: spacing.md,
            backgroundColor: colors.surfaceAlt,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
          accessibilityLiveRegion="polite"
        >
          <AppText variant="label" style={{ flexBasis: '100%' }}>
            {t('selectedCount', { count: selected.size })}
          </AppText>
          <Button compact label={t('moveTo')} variant="secondary" icon="folder" onPress={() => setMoveOpen(true)} />
          <Button compact label={t('moveToTrash')} variant="danger" icon="trash" onPress={confirmTrash} busy={actions.trash.isPending} />
          <Button compact label={t('done')} variant="secondary" onPress={() => setSelected(new Set())} />
        </View>
      ) : null}

      <FlatList
        data={rows}
        keyExtractor={(row) => (row.type === 'folder' ? `d-${row.folder.id}` : `f-${row.file.id}`)}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 120, flexGrow: 1 }}
        ListHeaderComponent={header}
        refreshControl={
          <RefreshControl refreshing={files.isRefetching && !files.isFetchingNextPage} onRefresh={refresh} tintColor={colors.primary} />
        }
        onEndReached={() => {
          if (files.hasNextPage && !files.isFetchingNextPage) void files.fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        initialNumToRender={14}
        windowSize={9}
        removeClippedSubviews
        ItemSeparatorComponent={() => <View style={{ height: spacing.xs }} />}
        ListEmptyComponent={
          files.isPending ? (
            <StateView kind="loading" title={t('loading')} />
          ) : files.isError ? (
            <StateView kind="error" title={describeError(files.error)} message={describeErrorDetail(files.error)} onRetry={refresh} />
          ) : (
            <StateView kind="empty" title={t(q.trim() || kind ? 'emptySearch' : 'emptyFiles')} />
          )
        }
        ListFooterComponent={
          files.hasNextPage ? (
            <Button
              label={t('loadMore')}
              variant="secondary"
              onPress={() => void files.fetchNextPage()}
              busy={files.isFetchingNextPage}
              style={{ marginTop: spacing.md }}
            />
          ) : undefined
        }
        renderItem={({ item }) =>
          item.type === 'folder' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${t('foldersHeading')}: ${item.folder.name}`}
              onPress={() => {
                setPath([...path, { id: item.folder.id, name: item.folder.name }]);
                setSelected(new Set());
              }}
              style={{
                minHeight: 64,
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.md,
                paddingHorizontal: spacing.md,
                borderRadius: radius.lg,
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.border,
              }}
            >
              <IconTile icon="folder" tone="primary" size={42} />
              <AppText style={{ flex: 1, fontWeight: '700' }} numberOfLines={1}>
                {isolate(item.folder.name)}
              </AppText>
              <View style={{ transform: [{ scaleX: I18nManager.isRTL ? -1 : 1 }] }}>
                <Icon name="chevron" size={20} color={colors.textMuted} />
              </View>
            </Pressable>
          ) : (
            <FileRow
              file={item.file}
              selected={selected.has(item.file.id)}
              selecting={selecting}
              locale={locale}
              onPress={() => (selecting ? toggle(item.file.id) : navigation.navigate('FileDetails', { fileId: item.file.id }))}
              onLongPress={() => toggle(item.file.id)}
            />
          )
        }
      />

      <View style={{ position: 'absolute', bottom: spacing.xl, end: spacing.xl }}>
        <Button
          label={t('add')}
          icon="plus"
          onPress={() => setAddOpen(true)}
          accessibilityHint={t('uploadFiles')}
          style={[{ borderRadius: radius.pill }, elevation(3)]}
        />
      </View>

      <ActionSheet
        visible={addOpen}
        title={t('add')}
        onClose={() => setAddOpen(false)}
        actions={[
          { label: t('uploadFiles'), onPress: () => void addFrom(pickDocuments) },
          { label: t('uploadPhotos'), onPress: () => void addFrom(pickPhotos) },
          { label: t('takePhoto'), onPress: () => void addFrom(takePhoto) },
          { label: t('newFolder'), onPress: () => setNewFolderOpen(true) },
        ]}
      />
      <PromptModal
        key={newFolderOpen ? 'open' : 'closed'}
        visible={newFolderOpen}
        title={t('newFolder')}
        label={t('folderName')}
        confirmLabel={t('save')}
        busy={actions.createFolder.isPending}
        error={actions.createFolder.isError ? describeError(actions.createFolder.error) : undefined}
        onClose={() => setNewFolderOpen(false)}
        onSubmit={(name) => actions.createFolder.mutate({ name, parentId: folderId }, { onSuccess: () => setNewFolderOpen(false) })}
      />
      <FolderPicker
        visible={moveOpen}
        onClose={() => setMoveOpen(false)}
        onPick={(target) => {
          setMoveOpen(false);
          actions.move.mutate(
            { ids: [...selected], folderId: target },
            { onSuccess: () => setSelected(new Set()), onError: (error) => setNotice(describeError(error)) },
          );
        }}
      />
    </Screen>
  );
}

const FAMILY_ICON: Partial<Record<ReturnType<typeof fileFamily>, IconName>> = {
  image: 'image',
  video: 'video',
  archive: 'archive',
  pdf: 'file',
  text: 'file',
  office: 'file',
  audio: 'file',
  other: 'file',
};
const FAMILY_TONE: Partial<Record<ReturnType<typeof fileFamily>, Tone>> = {
  image: 'accent',
  video: 'primary',
  pdf: 'danger',
  archive: 'warning',
  office: 'success',
};

function FileRow({
  file,
  selected,
  selecting,
  locale,
  onPress,
  onLongPress,
}: {
  file: FileItem;
  selected: boolean;
  selecting: boolean;
  locale: 'en' | 'ar' | 'fr';
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { colors } = useTheme();
  const family = fileFamily(file.mimeType, file.name);
  const meta = `${formatBytes(bytesToNumber(file.sizeBytes), locale)} · ${formatDate(file.createdAt, locale)}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${file.name}, ${meta}`}
      accessibilityState={{ selected }}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={{
        minHeight: 68,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.md,
        borderRadius: radius.lg,
        backgroundColor: selected ? colors.surfaceAlt : colors.surface,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? colors.primary : colors.border,
      }}
    >
      {selecting ? (
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: selected ? colors.primary : colors.surfaceAlt,
            borderWidth: selected ? 0 : 1,
            borderColor: colors.border,
          }}
        >
          {selected ? <Icon name="check" size={20} color={colors.onPrimary} strokeWidth={2.8} /> : null}
        </View>
      ) : (
        <IconTile icon={FAMILY_ICON[family] ?? 'file'} tone={FAMILY_TONE[family] ?? 'neutral'} size={42} />
      )}
      <View style={{ flex: 1 }}>
        <AppText style={{ fontWeight: '700' }} numberOfLines={1}>
          {isolate(file.name)}
        </AppText>
        <AppText variant="caption" muted numberOfLines={1}>
          {meta}
        </AppText>
      </View>
    </Pressable>
  );
}
