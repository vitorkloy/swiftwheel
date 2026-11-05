import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle } from 'lucide-react';
import { AppItem } from '../types';

interface ToastProps {
  app: AppItem | null;
}

export const Toast: React.FC<ToastProps> = ({ app }) => {
  /** Ações bem-sucedidas são silenciosas; este overlay fica reservado a falhas acionáveis. */
  const error = app?.id === 'error' ? app : null;

  return (
    <AnimatePresence>
      {error && (
        <div className="fixed bottom-12 left-0 w-full flex justify-center z-[100] pointer-events-none">
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 520, damping: 34, mass: 0.7 }}
            className="flex items-start gap-3 min-w-[240px] max-w-[420px] rounded-2xl px-4 py-3"
            style={{
              background: 'rgba(24,24,26,0.92)',
              backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0))',
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.12), 0 16px 40px rgba(0,0,0,0.45)',
              fontFamily: 'var(--font-ui)',
            }}
          >
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full" style={{ background: 'rgba(239,68,68,0.16)', color: '#f87171' }}>
              <AlertCircle size={14} strokeWidth={2.2} />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-white/92 truncate">{error.label}</div>
              {error.description && (
                <div className="mt-0.5 text-[11.5px] leading-snug text-white/55">{error.description}</div>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
