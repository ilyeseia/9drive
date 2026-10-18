import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useState } from 'react';
import { Alert, Image, ScrollView, View } from 'react-native';
import { bytesToNumber } from '../../api/schemas';
import { useServices, useTransfers } from '../../app/services';
import { formatBytes, formatDate, isolate } from '../../i18n/format';
import { useI18n } from '../../i18n/I18nProvider';
import { spacing, useTheme } from '../../theme/theme';
import { shareLocalFile } from '../../transfers/device';
import { canPreviewInApp, fileFamily } from '../../transfers/names';
import { progressFraction } from '../../transfers/manager';
import { AppText, Button, Card, Screen, StateView } from '../../ui/components';
import { PromptModal, ProgressBar } from '../../ui/extra';
import type { FilesStackParamList } from '../../navigation/FilesStack';
import { FolderPicker } from './FolderPicker';
import { useFileActions, useFileDetail } from './queries';

export function FileDetailsScreen() {
  const { fileId } = useRoute<RouteProp<FilesStackParamList, 'FileDetails'>>().params;
  const navigation = useNavigation();
  const { t, describeError, locale } = useI18n();
  const { colors } = useTheme();
  const { transfers } = useServices();
  const transferItems = useTransfers();
  const detail = useFileDetail(fileId);
  const actions = useFileActions();
  const [renameOpen, setRenameOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const file = detail.data;
  if (detail.isPending)
    return (
      <Screen>
        <StateView kind="loading" title={t('loading')} />
      </Screen>
    );
  if (detail.isError || !file)
    return (
      <Screen>
        <StateView kind="error" title={describeError(detail.error)} onRetry={() => void detail.refetch()} />
      </Screen>
    );

  const family = fileFamily(file.mimeType, file.name);
  const download = [...transferItems].reverse().find((i) => i.kind === 'download' && i.name === file.name && i.status !== 'cancelled');
  const downloading = download && (download.status === 'queued' || download.status === 'active');
  const localUri = download?.status === 'completed' ? download.localUri : null;

  function fail(error: unknown) {
    setMessage(describeError(error));
  }

  async function share() {
    if (!localUri || !file) return;
    const ok = await shareLocalFile(localUri, file.mimeType, file.name).catch(() => false);
    if (!ok) setMessage(t('shareUnavailable'));
  }

  function confirmTrash() {
    Alert.alert(t('trashConfirmTitle'), t('trashConfirmBody', { count: 1 }), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('moveToTrash'),
        style: 'destructive',
        onPress: () => actions.trash.mutate([fileId], { onSuccess: () => navigation.goBack(), onError: fail }),
      },
    ]);
  }

  return (
    <Screen padded={false}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ gap: spacing.xs }}>
          <AppText variant="title" accessibilityRole="header">
            {isolate(file.name)}
          </AppText>
          <AppText muted>{`${formatBytes(bytesToNumber(file.sizeBytes), locale)} · ${file.mimeType}`}</AppText>
        </View>

        {localUri && canPreviewInApp(family, file.mimeType) ? (
          <Image
            accessibilityLabel={file.name}
            source={{ uri: localUri }}
            resizeMode="contain"
            style={{ width: '100%', height: 260, borderRadius: 12 }}
          />
        ) : null}

        <Card style={{ gap: spacing.sm }}>
          <Detail label={t('detailSize')} value={formatBytes(bytesToNumber(file.sizeBytes), locale)} />
          <Detail label={t('detailType')} value={file.mimeType} />
          <Detail label={t('detailStorage')} value={isolate(file.connectedAccount?.email ?? file.provider)} />
          <Detail label={t('detailFolder')} value={file.folder ? isolate(file.folder.name) : t('noFolder')} />
          <Detail label={t('detailAdded')} value={formatDate(file.createdAt, locale, true)} />
        </Card>

        {message ? (
          <AppText accessibilityRole="alert" style={{ color: colors.danger }}>
            {message}
          </AppText>
        ) : null}

        {downloading ? (
          <View style={{ gap: spacing.xs }}>
            <ProgressBar fraction={progressFraction(download)} label={t('downloadingLabel')} />
            <Button label={t('cancel')} variant="secondary" onPress={() => transfers.cancel(download.id)} />
          </View>
        ) : localUri ? (
          <Button
            label={t('openPreview')}
            onPress={() => void share()}
            accessibilityHint={t(canPreviewInApp(family, file.mimeType) ? 'downloadHint' : 'previewUnsupported')}
          />
        ) : (
          <Button
            label={t('download')}
            accessibilityHint={t('downloadHint')}
            onPress={() => {
              setMessage(null);
              transfers.enqueueDownload({ id: file.id, name: file.name, size: bytesToNumber(file.sizeBytes) });
            }}
          />
        )}
        {download?.status === 'failed' ? (
          <AppText accessibilityRole="alert" muted>
            {t('transferFailed')} — {t('actionFailed')}
          </AppText>
        ) : null}

        <View style={{ gap: spacing.sm }}>
          <Button label={t('rename')} variant="secondary" onPress={() => setRenameOpen(true)} />
          <Button label={t('moveTo')} variant="secondary" onPress={() => setMoveOpen(true)} />
          <Button
            label={t('copyFile')}
            variant="secondary"
            busy={actions.copy.isPending}
            onPress={() =>
              actions.copy.mutate(
                { id: fileId, folderId: file.folderId ?? null },
                { onSuccess: () => setMessage(t('updated')), onError: fail },
              )
            }
          />
          <Button label={t('moveToTrash')} variant="danger" busy={actions.trash.isPending} onPress={confirmTrash} />
        </View>
      </ScrollView>

      <PromptModal
        key={renameOpen ? 'r-open' : 'r-closed'}
        visible={renameOpen}
        title={t('rename')}
        label={t('newName')}
        initialValue={file.name}
        confirmLabel={t('save')}
        busy={actions.rename.isPending}
        error={actions.rename.isError ? describeError(actions.rename.error) : null}
        onClose={() => setRenameOpen(false)}
        onSubmit={(name) => actions.rename.mutate({ id: fileId, name }, { onSuccess: () => setRenameOpen(false) })}
      />
      <FolderPicker
        visible={moveOpen}
        onClose={() => setMoveOpen(false)}
        onPick={(folderId) => {
          setMoveOpen(false);
          actions.move.mutate({ ids: [fileId], folderId }, { onSuccess: () => setMessage(t('updated')), onError: fail });
        }}
      />
    </Screen>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md }}>
      <AppText muted>{label}</AppText>
      <AppText style={{ flexShrink: 1 }}>{value}</AppText>
    </View>
  );
}
