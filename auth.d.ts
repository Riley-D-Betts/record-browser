import type { UserRole } from './shared/constants'

declare module '#auth-utils' {
  interface User {
    id: string
    email: string
    name: string
    role: UserRole
  }

  interface UserSession {
    loggedInAt: string
  }
}

export {}
