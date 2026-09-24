-- Folio — limite des sessions gratuites par IP et par jour
--
-- À exécuter une fois dans Supabase (SQL Editor → New query → Run).
-- Tant que ce script n'est pas appliqué, l'API fonctionne comme avant
-- (sans limite par IP) et écrit un avertissement dans les logs Vercel.
--
-- Aucune adresse IP n'est stockée : l'API envoie une empreinte HMAC
-- (clé secrète + date du jour), impossible à relier d'un jour à l'autre.
-- Les lignes de plus de 48 h sont supprimées automatiquement.
--
-- Prérequis : SUPABASE_KEY (variable Vercel) doit être la clé "service_role".

create table if not exists public.uid_creations (
  ip_hash text    not null,
  day     date    not null default current_date,
  count   integer not null default 0,
  primary key (ip_hash, day)
);

-- Aucune policy : table inaccessible avec la clé anon, seule service_role y accède.
alter table public.uid_creations enable row level security;
revoke all on public.uid_creations from anon, authenticated;
grant select, insert, update, delete on public.uid_creations to service_role;

-- Incrémente le compteur de l'IP pour aujourd'hui (atomique) et indique si
-- ce nouvel identifiant a encore droit aux sessions gratuites.
create or replace function public.folio_register_uid(p_ip_hash text, p_limit integer)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  n integer;
begin
  insert into uid_creations as u (ip_hash, day, count)
  values (p_ip_hash, current_date, 1)
  on conflict (ip_hash, day) do update set count = u.count + 1
  returning u.count into n;

  delete from uid_creations where day < current_date - 1;

  return n <= p_limit;
end;
$$;

revoke all on function public.folio_register_uid(text, integer) from public, anon, authenticated;
grant execute on function public.folio_register_uid(text, integer) to service_role;
