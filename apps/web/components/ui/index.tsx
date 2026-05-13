/**
 * Minimal UI primitives for Phase 5 (no shadcn dependency).
 * All use Tailwind utility classes already configured.
 */
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from 'react';

function cn(...classes: Array<string | undefined | false>): string {
  return classes.filter(Boolean).join(' ');
}

// ─── Button ──────────────────────────────────────────────────────────────────
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'destructive';
  size?: 'sm' | 'md' | 'lg';
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => {
    const base =
      'inline-flex items-center justify-center rounded-md font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed';
    const sizes = {
      sm: 'px-3 py-1.5 text-xs',
      md: 'px-4 py-2 text-sm',
      lg: 'px-5 py-2.5 text-base',
    };
    const variants = {
      primary: 'bg-primary text-primary-foreground hover:opacity-90',
      secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
      ghost: 'hover:bg-accent hover:text-accent-foreground',
      destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
    };
    return <button ref={ref} className={cn(base, sizes[size], variants[variant], className)} {...props} />;
  },
);
Button.displayName = 'Button';

// ─── Input ───────────────────────────────────────────────────────────────────
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'w-full px-3 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

// ─── Textarea ────────────────────────────────────────────────────────────────
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full px-3 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 min-h-[140px] resize-y font-[inherit] leading-relaxed',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

// ─── Select ──────────────────────────────────────────────────────────────────
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        'w-full px-3 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = 'Select';

// ─── Label ───────────────────────────────────────────────────────────────────
export function Label({ children, htmlFor, required }: { children: ReactNode; htmlFor?: string; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium leading-none">
      {children}
      {required && <span className="text-destructive ml-0.5">*</span>}
    </label>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('bg-card border border-border rounded-lg p-6 shadow-sm', className)}>{children}</div>
  );
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex items-center justify-between mb-4', className)}>{children}</div>;
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-lg font-medium">{children}</h2>;
}

// ─── Badge ───────────────────────────────────────────────────────────────────
export function Badge({
  children,
  variant = 'default',
}: {
  children: ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'destructive' | 'muted';
}) {
  const variants = {
    default: 'bg-primary text-primary-foreground',
    success: 'bg-green-600 text-white',
    warning: 'bg-yellow-500 text-white',
    destructive: 'bg-destructive text-destructive-foreground',
    muted: 'bg-muted text-muted-foreground',
  };
  return (
    <span className={cn('inline-flex items-center text-xs px-2 py-0.5 rounded-md font-medium', variants[variant])}>
      {children}
    </span>
  );
}

// ─── Status pill helpers ────────────────────────────────────────────────────
export function ProductStatusBadge({ status }: { status: string }) {
  const variant =
    status === 'active'
      ? 'success'
      : status === 'draft'
        ? 'muted'
        : status === 'pending_approval'
          ? 'warning'
          : status === 'blocked'
            ? 'destructive'
            : 'muted';
  return <Badge variant={variant}>{status}</Badge>;
}

export function StockStatusBadge({ status }: { status: string }) {
  const variant =
    status === 'in_stock'
      ? 'success'
      : status === 'low_stock'
        ? 'warning'
        : status === 'out_of_stock'
          ? 'destructive'
          : 'muted';
  return <Badge variant={variant}>{status.replace(/_/g, ' ')}</Badge>;
}
