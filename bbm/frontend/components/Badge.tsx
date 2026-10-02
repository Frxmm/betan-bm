import { STATUS_LABEL } from '../lib/utils'

export function Badge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status] ?? status}</span>
}

export function StatusChip({ status }: { status: string }) {
  return <span className={`status-chip ${status}`}>{STATUS_LABEL[status] ?? status}</span>
}
