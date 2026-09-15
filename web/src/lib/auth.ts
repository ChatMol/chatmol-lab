import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

// Desktop authentication is completed by the hosted browser flow. The local
// daemon only verifies the returned one-time code and mints its local JWT, so
// it never needs hosted OAuth providers or a server user database adapter.
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [],
});
