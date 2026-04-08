interface IpcOutputState {
  count: number;
  latestText: string | null;
  deliveredAt: number | null;
}

export interface IpcOutputSnapshot extends IpcOutputState {}

const ipcOutputTracker = new Map<string, IpcOutputState>();

function buildTrackerKey(sourceGroup: string, chatJid: string): string {
  return `${sourceGroup}::${chatJid}`;
}

export function getIpcOutputSnapshot(
  sourceGroup: string,
  chatJid: string,
): IpcOutputSnapshot {
  const state = ipcOutputTracker.get(buildTrackerKey(sourceGroup, chatJid));
  return (
    state ?? {
      count: 0,
      latestText: null,
      deliveredAt: null,
    }
  );
}

export function recordIpcOutputDelivered(
  sourceGroup: string,
  chatJid: string,
  text: string,
): IpcOutputSnapshot {
  const key = buildTrackerKey(sourceGroup, chatJid);
  const current = getIpcOutputSnapshot(sourceGroup, chatJid);
  const next: IpcOutputState = {
    count: current.count + 1,
    latestText: text,
    deliveredAt: Date.now(),
  };
  ipcOutputTracker.set(key, next);
  return next;
}

export function resetIpcOutputTracker(): void {
  ipcOutputTracker.clear();
}
