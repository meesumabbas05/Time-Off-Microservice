export const VALID_SUBMISSION_BODY = {
  locationId: 'LOC-PK',
  leaveType: 'VACATION',
  startDate: '2026-06-01',
  endDate: '2026-06-05',
  timezone: 'Asia/Karachi',
};

export const MALICIOUS_SUBMISSION_BODY = {
  ...VALID_SUBMISSION_BODY,
  status: 'APPROVED',
  decidedBy: 'hacker_manager_uuid',
  days_requested: 0.001,
};

export const APPROVE_BODY = (managerId: string) => ({ managerId });
export const REJECT_BODY = (reason: string) => ({ reason });
