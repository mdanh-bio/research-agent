import type { ComputeApprovalDecision } from '../../shared/compute'
import { normalizeComputeApprovalDecision } from '../../shared/compute'

export const readComputeApprovalResponse = (
  value: unknown
): { id: string; decision: ComputeApprovalDecision } => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('A compute approval response object is required.')
  }
  const record = value as Record<string, unknown>
  if (typeof record['id'] !== 'string' || !record['id'].trim()) {
    throw new Error('A non-empty compute approval id is required.')
  }
  return {
    id: record['id'],
    decision: normalizeComputeApprovalDecision(record['decision'])
  }
}
