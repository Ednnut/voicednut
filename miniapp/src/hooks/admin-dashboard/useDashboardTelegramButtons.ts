import { backButton, settingsButton } from '@tma.js/sdk-react';
import { useEffect } from 'react';

import type { DashboardDialogState } from '@/hooks/admin-dashboard/useDashboardDialog';
import type { DashboardModule } from '@/pages/AdminDashboard/dashboardShellConfig';

type TelegramButtonLifecycleControl = {
  mount?: { ifAvailable?: () => void };
  unmount?: { ifAvailable?: () => void };
  show?: { ifAvailable?: () => void };
  hide?: { ifAvailable?: () => void };
};

type UseDashboardTelegramButtonsOptions = {
  settingsButtonSupported: boolean;
  toggleSettings: (next?: boolean, options?: { fallbackModule?: DashboardModule }) => void;
  openOverflowMenu?: () => void;
  closeOverflowMenu?: () => void;
  returnToHome: () => void;
  dialogState: DashboardDialogState | null;
  dismissDialog: (state: DashboardDialogState | null) => void;
  triggerHaptic: (
    mode: 'selection' | 'impact' | 'success' | 'warning' | 'error',
    impactStyle?: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft',
  ) => void;
  settingsOpen: boolean;
  overflowMenuOpen?: boolean;
  focusedWorkspaceMode: boolean;
  activeModule: DashboardModule;
};

const settingsLifecycleControl = settingsButton as unknown as TelegramButtonLifecycleControl;
const backButtonLifecycleControl = backButton as unknown as TelegramButtonLifecycleControl;

export function useDashboardTelegramButtons({
  settingsButtonSupported,
  toggleSettings,
  openOverflowMenu,
  closeOverflowMenu,
  returnToHome,
  dialogState,
  dismissDialog,
  triggerHaptic,
  settingsOpen,
  overflowMenuOpen = false,
  focusedWorkspaceMode,
  activeModule,
}: UseDashboardTelegramButtonsOptions): void {
  useEffect(() => {
    if (!settingsButtonSupported) return undefined;
    settingsLifecycleControl.mount?.ifAvailable?.();
    settingsLifecycleControl.show?.ifAvailable?.();
    return () => {
      settingsLifecycleControl.hide?.ifAvailable?.();
      settingsLifecycleControl.unmount?.ifAvailable?.();
    };
  }, [settingsButtonSupported]);

  useEffect(() => {
    backButtonLifecycleControl.mount?.ifAvailable?.();
    return () => {
      backButtonLifecycleControl.hide?.ifAvailable?.();
      backButtonLifecycleControl.unmount?.ifAvailable?.();
    };
  }, []);

  useEffect(() => {
    if (!settingsButton.onClick.isAvailable()) {
      return undefined;
    }
    return settingsButton.onClick(() => {
      if (openOverflowMenu) {
        openOverflowMenu();
        return;
      }
      toggleSettings();
    });
  }, [openOverflowMenu, toggleSettings]);

  useEffect(() => {
    if (
      Boolean(dialogState)
      || settingsOpen
      || overflowMenuOpen
      || focusedWorkspaceMode
      || activeModule !== 'ops'
    ) {
      backButtonLifecycleControl.show?.ifAvailable?.();
      return;
    }
    backButtonLifecycleControl.hide?.ifAvailable?.();
  }, [activeModule, dialogState, focusedWorkspaceMode, overflowMenuOpen, settingsOpen]);

  useEffect(() => {
    if (!backButton.onClick.isAvailable()) {
      return undefined;
    }
    return backButton.onClick(() => {
      if (dialogState) {
        dismissDialog(dialogState);
        triggerHaptic('selection');
        return;
      }
      if (overflowMenuOpen) {
        closeOverflowMenu?.();
        triggerHaptic('selection');
        return;
      }
      if (settingsOpen) {
        triggerHaptic('selection');
        returnToHome();
        return;
      }
      if (focusedWorkspaceMode || activeModule !== 'ops') {
        triggerHaptic('selection');
        returnToHome();
        return;
      }
      if (typeof window !== 'undefined' && window.history.length > 1) {
        triggerHaptic('impact', 'light');
        window.history.back();
      }
    });
  }, [
    activeModule,
    closeOverflowMenu,
    dialogState,
    dismissDialog,
    focusedWorkspaceMode,
    overflowMenuOpen,
    returnToHome,
    settingsOpen,
    triggerHaptic,
  ]);
}
