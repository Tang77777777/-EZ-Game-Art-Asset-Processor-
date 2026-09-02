import { motion } from "motion/react";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof motion.button> & { className?: string };

/** 带缩放微交互的图标按钮 */
export default function IconBtn({ className = "", ...props }: Props) {
  return (
    <motion.button
      type="button"
      whileHover={{ scale: 1.12 }}
      whileTap={{ scale: 0.85 }}
      className={`icon-btn ${className}`}
      {...props}
    />
  );
}
