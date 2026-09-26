import { createAdminClient } from '@/lib/supabase/admin';

export type DraftStep =
  | 'awaiting_photo'
  | 'awaiting_caption'
  | 'awaiting_time'
  | 'awaiting_confirm';

export type Destination = 'group' | 'channel';

export type Draft = {
  id: string;
  admin_telegram_id: number;
  step: DraftStep;
  image_file_id: string | null;
  caption: string | null;
  send_at: string | null;
  destination: Destination;
  is_ad: boolean;
};

export async function getDraft(adminId: number): Promise<Draft | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('post_drafts')
    .select('id, admin_telegram_id, step, image_file_id, caption, send_at, destination, is_ad')
    .eq('admin_telegram_id', adminId)
    .maybeSingle();
  return data as Draft | null;
}

export async function startDraft(
  adminId: number,
  destination: Destination,
  isAd: boolean
) {
  const supabase = createAdminClient();
  await supabase.from('post_drafts').upsert(
    {
      admin_telegram_id: adminId,
      step: 'awaiting_photo',
      image_file_id: null,
      caption: null,
      send_at: null,
      destination,
      is_ad: isAd,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'admin_telegram_id' }
  );
}

export async function setPhoto(adminId: number, fileId: string | null, step: DraftStep) {
  const supabase = createAdminClient();
  await supabase
    .from('post_drafts')
    .update({
      image_file_id: fileId,
      step,
      updated_at: new Date().toISOString(),
    })
    .eq('admin_telegram_id', adminId);
}

export async function setCaption(adminId: number, caption: string | null, step: DraftStep) {
  const supabase = createAdminClient();
  await supabase
    .from('post_drafts')
    .update({
      caption,
      step,
      updated_at: new Date().toISOString(),
    })
    .eq('admin_telegram_id', adminId);
}

export async function setSendAt(adminId: number, sendAt: Date) {
  const supabase = createAdminClient();
  await supabase
    .from('post_drafts')
    .update({
      send_at: sendAt.toISOString(),
      step: 'awaiting_confirm',
      updated_at: new Date().toISOString(),
    })
    .eq('admin_telegram_id', adminId);
}

export async function clearDraft(adminId: number) {
  const supabase = createAdminClient();
  await supabase.from('post_drafts').delete().eq('admin_telegram_id', adminId);
}
