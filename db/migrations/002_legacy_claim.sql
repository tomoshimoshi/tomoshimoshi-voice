-- Allow atomic ownership transfer when the reserved owner first signs in with
-- an unverified email and verifies it later. Constraints are checked at commit.
ALTER TABLE requests ALTER CONSTRAINT requests_user_id_call_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE call_consents ALTER CONSTRAINT call_consents_user_id_call_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
