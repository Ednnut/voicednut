import { UiButton } from '@/components/ui/AdminPrimitives';
import { DashboardAvatar } from '@/components/admin-dashboard/DashboardAvatar';
import {
  describeSessionIdentityLabel,
  describeSessionRole,
  describeSessionSource,
} from '@/contracts/miniappAccessExperience';

type ModuleItem = {
  id: string;
  label: string;
};

type DashboardMainHeaderProps = {
  userLabel: string;
  userAvatarUrl: string;
  userAvatarFallback: string;
  sessionRole: string;
  sessionRoleSource: string;
  settingsStatusLabel: string;
  featureFlagsCount: number | string;
  moduleDetail: string;
  activeModuleGlyph: string;
  loading: boolean;
  compact?: boolean;
  onOpenSettings: () => void;
  onOpenOverflowMenu?: () => void;
};

type DashboardModuleNavProps = {
  modules: ModuleItem[];
  activeModuleId: string;
  onSelectModule: (moduleId: string) => void;
};

type DashboardFocusedHeaderProps = {
  title: string;
  subtitle: string;
  userAvatarUrl: string;
  userAvatarFallback: string;
  loading: boolean;
  onOpenSettings: () => void;
  onOpenOverflowMenu?: () => void;
};

type DashboardBottomNavProps = {
  modules: ModuleItem[];
  activeModuleId: string;
  moduleGlyph: (moduleId: string) => string;
  onSelectModule: (moduleId: string) => void;
};

type DashboardProfileAvatarButtonProps = {
  userLabel: string;
  userAvatarUrl: string;
  userAvatarFallback: string;
  compact?: boolean;
  loading: boolean;
  onOpenSettings: () => void;
};

type DashboardOverflowTriggerProps = {
  loading: boolean;
  onOpenOverflowMenu?: () => void;
};

type DashboardOverflowMenuProps = {
  open: boolean;
  loading: boolean;
  closeDisabled: boolean;
  settingsStatusLabel: string;
  featureFlagsCount: number | string;
  onClose: () => void;
  onOpenSettings: () => void;
  onRefreshDashboard: () => void;
  onShareMiniApp: () => void;
  onCloseMiniApp?: () => void;
};

function DashboardProfileAvatarButton({
  userLabel,
  userAvatarUrl,
  userAvatarFallback,
  compact = false,
  loading,
  onOpenSettings,
}: DashboardProfileAvatarButtonProps) {
  const triggerClass = compact
    ? 'va-profile-trigger va-profile-trigger-sm'
    : 'va-profile-trigger';
  const profileAlt = compact ? 'Profile' : `${userLabel} profile`;
  return (
    <UiButton
      variant="plain"
      className={triggerClass}
      aria-label="Open settings"
      title="Open settings"
      onClick={onOpenSettings}
      disabled={loading}
    >
      <DashboardAvatar
        src={userAvatarUrl}
        alt={profileAlt}
        fallback={userAvatarFallback}
      />
    </UiButton>
  );
}

function resolveHeaderPosture(sessionRole: string): { label: string; tone: 'success' | 'warning' | 'info' } {
  const normalizedRole = sessionRole.trim().toLowerCase();
  if (normalizedRole === 'admin') {
    return { label: 'Admin console healthy', tone: 'success' };
  }
  if (normalizedRole === 'viewer' || normalizedRole === 'guest') {
    return { label: 'Limited access', tone: 'warning' };
  }
  return { label: 'Ready for work', tone: 'info' };
}

function formatFeatureFlagsLabel(featureFlagsCount: number | string): string {
  if (typeof featureFlagsCount === 'number') {
    return featureFlagsCount > 0 ? `${featureFlagsCount} active` : 'default';
  }
  const normalized = String(featureFlagsCount).trim();
  return normalized.length > 0 ? normalized : 'default';
}

function DashboardOverflowTrigger({
  loading,
  onOpenOverflowMenu,
}: DashboardOverflowTriggerProps) {
  if (!onOpenOverflowMenu) {
    return null;
  }
  return (
    <UiButton
      variant="plain"
      className="va-overflow-trigger"
      aria-label="Open Mini App menu"
      title="Open menu"
      onClick={onOpenOverflowMenu}
      disabled={loading}
    >
      <span className="va-overflow-dots" aria-hidden>...</span>
    </UiButton>
  );
}

export function DashboardMainHeader({
  userLabel,
  userAvatarUrl,
  userAvatarFallback,
  sessionRole,
  sessionRoleSource,
  settingsStatusLabel,
  featureFlagsCount,
  moduleDetail,
  activeModuleGlyph,
  loading,
  compact = false,
  onOpenSettings,
  onOpenOverflowMenu,
}: DashboardMainHeaderProps) {
  const posture = resolveHeaderPosture(sessionRole);
  const normalizedRoleSource = sessionRoleSource.replace(/_/g, ' ');
  const sessionIdentityLabel = describeSessionIdentityLabel(sessionRole);
  const sessionAccessLabel = describeSessionRole(sessionRole);
  const sessionSourceLabel = describeSessionSource(sessionRole, sessionRoleSource);
  const flagsLabel = formatFeatureFlagsLabel(featureFlagsCount);

  return (
    <header className={`va-title-card va-header${compact ? ' is-compact' : ''}`}>
      <div className="va-telegram-topbar">
        <div className="va-telegram-topbar-left">
          <DashboardProfileAvatarButton
            userLabel={userLabel}
            userAvatarUrl={userAvatarUrl}
            userAvatarFallback={userAvatarFallback}
            compact={compact}
            loading={loading}
            onOpenSettings={onOpenSettings}
          />
          <div className="va-telegram-app-title">
            <span>Voicednut</span>
            <small>Mini App admin</small>
          </div>
        </div>
        <DashboardOverflowTrigger
          loading={loading}
          onOpenOverflowMenu={onOpenOverflowMenu}
        />
      </div>

      <div className="va-wallet-hero">
        <div className="va-wallet-hero-copy">
          <span className={`va-wallet-status-pill is-${posture.tone}`}>{posture.label}</span>
          <h1 className="va-title-card-title">VOICEDNUT</h1>
          <p className="va-module-context-line va-muted">
            <span className="va-module-context-icon" aria-hidden>{activeModuleGlyph}</span>
            <span>{moduleDetail}</span>
          </p>
        </div>
        <div className="va-wallet-hero-glyph" aria-hidden>{activeModuleGlyph}</div>
      </div>

      <div className="va-wallet-action-grid" aria-label="Workspace summary">
        <div className="va-wallet-action-card">
          <span className="va-wallet-action-icon" aria-hidden>U</span>
          <span className="va-wallet-action-copy">
            <small>{sessionIdentityLabel}</small>
            <strong>{userLabel}</strong>
            <em>{sessionSourceLabel}</em>
          </span>
        </div>
        <div className="va-wallet-action-card">
          <span className="va-wallet-action-icon" aria-hidden>A</span>
          <span className="va-wallet-action-copy">
            <small>Access</small>
            <strong>{sessionAccessLabel}</strong>
            <em>Source {normalizedRoleSource}</em>
          </span>
        </div>
        <div className="va-wallet-action-card">
          <span className="va-wallet-action-icon" aria-hidden>W</span>
          <span className="va-wallet-action-copy">
            <small>Workspace</small>
            <strong>{settingsStatusLabel}</strong>
            <em>Flags {flagsLabel}</em>
          </span>
        </div>
      </div>
    </header>
  );
}

export function DashboardModuleNav({
  modules,
  activeModuleId,
  onSelectModule,
}: DashboardModuleNavProps) {
  return (
    <nav className="va-module-nav" aria-label="Module navigation">
      {modules.map((module, index) => (
        <UiButton
          key={module.id}
          id={`va-module-chip-${module.id}`}
          variant="chip"
          className={activeModuleId === module.id ? 'is-active' : ''}
          aria-pressed={activeModuleId === module.id}
          aria-current={activeModuleId === module.id ? 'page' : undefined}
          aria-label={`Open ${module.label} module`}
          aria-keyshortcuts={`Alt+${index + 1}`}
          aria-controls="va-view-stage-root"
          onClick={() => onSelectModule(module.id)}
        >
          {module.label}
        </UiButton>
      ))}
    </nav>
  );
}

export function DashboardFocusedHeader({
  title,
  subtitle,
  userAvatarUrl,
  userAvatarFallback,
  loading,
  onOpenSettings,
  onOpenOverflowMenu,
}: DashboardFocusedHeaderProps) {
  return (
    <header className="va-title-card va-focused-header">
      <div className="va-telegram-topbar">
        <div className="va-telegram-topbar-left">
          <DashboardProfileAvatarButton
            userLabel={title}
            userAvatarUrl={userAvatarUrl}
            userAvatarFallback={userAvatarFallback}
            compact
            loading={loading}
            onOpenSettings={onOpenSettings}
          />
          <div className="va-telegram-app-title">
            <span>{title}</span>
            <small>Focused workspace</small>
          </div>
        </div>
        <DashboardOverflowTrigger
          loading={loading}
          onOpenOverflowMenu={onOpenOverflowMenu}
        />
      </div>
      <div className="va-focused-summary">
        <h2 className="va-page-title va-title-card-title">{title}</h2>
        <p className="va-muted va-title-card-note">{subtitle}</p>
      </div>
    </header>
  );
}

export function DashboardOverflowMenu({
  open,
  loading,
  closeDisabled,
  settingsStatusLabel,
  featureFlagsCount,
  onClose,
  onOpenSettings,
  onRefreshDashboard,
  onShareMiniApp,
  onCloseMiniApp,
}: DashboardOverflowMenuProps) {
  if (!open) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className="va-overflow-backdrop"
        aria-label="Close Mini App menu"
        onClick={onClose}
      />
      <aside className="va-overflow-menu" role="dialog" aria-modal="true" aria-label="Mini App menu">
        <div className="va-overflow-menu-head">
          <span>
            <strong>Voicednut</strong>
            <small>{settingsStatusLabel}</small>
          </span>
          <UiButton
            variant="plain"
            className="va-overflow-close"
            aria-label="Close menu"
            onClick={onClose}
          >
            x
          </UiButton>
        </div>
        <div className="va-overflow-menu-meta">
          <span>Feature flags</span>
          <strong>{formatFeatureFlagsLabel(featureFlagsCount)}</strong>
        </div>
        <div className="va-overflow-menu-list">
          <UiButton
            variant="plain"
            className="va-overflow-menu-row"
            onClick={onOpenSettings}
            disabled={loading}
          >
            <span aria-hidden>S</span>
            <strong>Settings</strong>
          </UiButton>
          <UiButton
            variant="plain"
            className="va-overflow-menu-row"
            onClick={onRefreshDashboard}
            disabled={loading}
          >
            <span aria-hidden>R</span>
            <strong>Refresh workspace</strong>
          </UiButton>
          <UiButton
            variant="plain"
            className="va-overflow-menu-row"
            onClick={onShareMiniApp}
          >
            <span aria-hidden>L</span>
            <strong>Share Mini App</strong>
          </UiButton>
          {onCloseMiniApp ? (
            <UiButton
              variant="plain"
              className="va-overflow-menu-row is-danger"
              onClick={onCloseMiniApp}
              disabled={closeDisabled}
            >
              <span aria-hidden>X</span>
              <strong>Close Mini App</strong>
            </UiButton>
          ) : null}
        </div>
      </aside>
    </>
  );
}

export function DashboardBottomNav({
  modules,
  activeModuleId,
  moduleGlyph,
  onSelectModule,
}: DashboardBottomNavProps) {
  return (
    <nav className="va-bottom-nav-wrap" aria-label="Quick module navigation">
      <div className="va-bottom-nav">
        {modules.map((module, index) => (
          <UiButton
            key={`bottom-${module.id}`}
            id={`va-module-bottom-${module.id}`}
            variant="plain"
            className={`va-bottom-nav-item ${activeModuleId === module.id ? 'is-active' : ''}`}
            aria-current={activeModuleId === module.id ? 'page' : undefined}
            aria-label={`Open ${module.label} module`}
            aria-keyshortcuts={`Alt+${index + 1}`}
            aria-controls="va-view-stage-root"
            onClick={() => onSelectModule(module.id)}
          >
            <span className="va-bottom-nav-glyph" aria-hidden>{moduleGlyph(module.id)}</span>
            <span>{module.label}</span>
          </UiButton>
        ))}
      </div>
    </nav>
  );
}
