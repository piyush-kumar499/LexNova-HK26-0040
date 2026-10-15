export interface AuditLogRow {
  id: string;
  device_id: string | null;
  incident_id: string | null;
  event_type: string;
  event_data: Record<string, unknown> | null;
  created_at: string;
}
