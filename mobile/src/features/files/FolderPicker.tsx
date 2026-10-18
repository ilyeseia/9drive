import { Pressable } from 'react-native';
import { isolate } from '../../i18n/format';
import { useI18n } from '../../i18n/I18nProvider';
import { MIN_TARGET, spacing, useTheme } from '../../theme/theme';
import { AppText, StateView } from '../../ui/components';
import { Sheet } from '../../ui/extra';
import { folderPaths, useAllFolders } from './queries';

/** "Move to…" destination chooser. `null` means "no folder". */
export function FolderPicker({
  visible,
  onClose,
  onPick,
  excludeId,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (folderId: string | null) => void;
  excludeId?: string | null;
}) {
  const { t, describeError } = useI18n();
  const { colors } = useTheme();
  const folders = useAllFolders(visible);
  const options = folders.data ? folderPaths(folders.data).filter((f) => f.id !== excludeId) : [];

  return (
    <Sheet visible={visible} title={t('chooseFolder')} onClose={onClose}>
      {folders.isPending ? <StateView kind="loading" title={t('loading')} /> : null}
      {folders.isError ? <StateView kind="error" title={describeError(folders.error)} onRetry={() => void folders.refetch()} /> : null}
      {folders.data ? (
        <>
          <Row label={t('rootFolder')} onPress={() => onPick(null)} color={colors.text} />
          {options.map((option) => (
            <Row key={option.id} label={isolate(option.label)} onPress={() => onPick(option.id)} color={colors.text} />
          ))}
        </>
      ) : null}
    </Sheet>
  );
}

function Row({ label, onPress, color }: { label: string; onPress: () => void; color: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ minHeight: MIN_TARGET, justifyContent: 'center', paddingHorizontal: spacing.sm }}
    >
      <AppText style={{ color, fontWeight: '600' }}>{label}</AppText>
    </Pressable>
  );
}
