'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { Plan } from '@/lib/data/pricing'
import { ContactModal } from './contact-modal'
import { AuthModal } from './auth-modal'
import { useAuth } from './auth-context'

type ModelId = Plan['id']

type ModalContextValue = {
  open: (model?: ModelId) => void
}

const ModalContext = createContext<ModalContextValue | null>(null)

export function useContactModal() {
  const ctx = useContext(ModalContext)
  if (!ctx) throw new Error('useContactModal must be used within ModalProvider')
  return ctx
}

type ModalState =
  | { kind: 'closed' }
  | { kind: 'contact'; model: ModelId }
  | { kind: 'auth'; pendingModel: ModelId }
  | { kind: 'awaiting-session'; pendingModel: ModelId }

/**
 * Owns both the contact/order modal and the auth modal.
 *
 * When the visitor clicks "Поръчай сега", this checks the auth session first.
 * If signed in, the contact modal opens directly. If not, the auth modal opens
 * instead; after a successful sign-in, the contact modal opens automatically.
 */
export function ModalProvider({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  const [modalState, setModalState] = useState<ModalState>({ kind: 'closed' })
  const triggerRef = useRef<HTMLElement | null>(null)

  const open = useCallback(
    (selected: ModelId = 'standard') => {
      triggerRef.current = document.activeElement as HTMLElement | null

      if (loading) {
        setModalState({ kind: 'awaiting-session', pendingModel: selected })
      } else if (session) {
        setModalState({ kind: 'contact', model: selected })
      } else {
        setModalState({ kind: 'auth', pendingModel: selected })
      }
    },
    [session, loading],
  )

  useEffect(() => {
    if (loading) return
    if (modalState.kind === 'awaiting-session') {
      setModalState(
        session
          ? { kind: 'contact', model: modalState.pendingModel }
          : { kind: 'auth', pendingModel: modalState.pendingModel },
      )
      return
    }
    if (session && modalState.kind === 'auth') {
      setModalState({ kind: 'contact', model: modalState.pendingModel })
    }
  }, [session, loading, modalState])

  const close = useCallback(() => {
    setModalState({ kind: 'closed' })
    triggerRef.current?.focus?.()
  }, [])

  return (
    <ModalContext.Provider value={{ open }}>
      {children}
      {modalState.kind === 'auth' && <AuthModal onClose={close} />}
      {modalState.kind === 'contact' && (
        <ContactModal initialModel={modalState.model} onClose={close} />
      )}
    </ModalContext.Provider>
  )
}
