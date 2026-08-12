import berdIconMask from "@/shared/assets/berd-icon-mask.png";
import { cn } from "@/shared/lib/cn";

/** Berd app mark — silhouette mask tinted with `currentColor`. */
export function BerdIcon({ className = "" }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Berd"
      className={cn("inline-block bg-current", className)}
      style={{
        WebkitMaskImage: `url(${berdIconMask})`,
        maskImage: `url(${berdIconMask})`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}

export function Rain({ className = "" }: { className?: string }) {
  return (
    <svg
      width="103"
      height="103"
      viewBox="0 0 103 103"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <title>Wind effect</title>
      <g id="wind">
        <g id="rain-1" className="animate-[wind_2s_linear_infinite]">
          <path
            d="M66 33L62 37"
            stroke="url(#paint10_linear)"
            strokeLinecap="round"
          />
          <path
            d="M70 43L68 45"
            stroke="url(#paint11_linear)"
            strokeLinecap="round"
          />
          <path
            d="M60 34L59 35"
            stroke="url(#paint12_linear)"
            strokeLinecap="round"
          />
          <path
            d="M56 47L52 51"
            stroke="url(#paint13_linear)"
            strokeLinecap="round"
          />
          <path
            d="M98 1L94 5"
            stroke="url(#paint14_linear)"
            strokeLinecap="round"
          />
          <path
            d="M102 11L100 13"
            stroke="url(#paint15_linear)"
            strokeLinecap="round"
          />
          <path
            d="M88 15L84 19"
            stroke="url(#paint16_linear)"
            strokeLinecap="round"
          />
          <path
            d="M76 26L72 30"
            stroke="url(#paint17_linear)"
            strokeLinecap="round"
          />
          <path
            d="M87 28L83 32"
            stroke="url(#paint18_linear)"
            strokeLinecap="round"
          />
          <path
            d="M76 34L74 36"
            stroke="url(#paint19_linear)"
            strokeLinecap="round"
          />
        </g>
        <g id="rain-2" className="animate-[wind_2s_linear_1s_infinite]">
          <path
            d="M66 33L62 37"
            stroke="url(#paint0_linear)"
            strokeLinecap="round"
          />
          <path
            d="M70 43L68 45"
            stroke="url(#paint1_linear)"
            strokeLinecap="round"
          />
          <path
            d="M60 34L59 35"
            stroke="url(#paint2_linear)"
            strokeLinecap="round"
          />
          <path
            d="M56 47L52 51"
            stroke="url(#paint3_linear)"
            strokeLinecap="round"
          />
          <path
            d="M98 1L94 5"
            stroke="url(#paint4_linear)"
            strokeLinecap="round"
          />
          <path
            d="M102 11L100 13"
            stroke="url(#paint5_linear)"
            strokeLinecap="round"
          />
          <path
            d="M88 15L84 19"
            stroke="url(#paint6_linear)"
            strokeLinecap="round"
          />
          <path
            d="M76 26L72 30"
            stroke="url(#paint7_linear)"
            strokeLinecap="round"
          />
          <path
            d="M87 28L83 32"
            stroke="url(#paint8_linear)"
            strokeLinecap="round"
          />
          <path
            d="M76 34L74 36"
            stroke="url(#paint9_linear)"
            strokeLinecap="round"
          />
        </g>
      </g>
      <defs>
        <linearGradient
          id="paint0_linear"
          x1="64"
          y1="32.9437"
          x2="64"
          y2="37.0563"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint1_linear"
          x1="69"
          y1="42.9719"
          x2="69"
          y2="45.0281"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint2_linear"
          x1="59.5"
          y1="33.9859"
          x2="59.5"
          y2="35.0141"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint3_linear"
          x1="54"
          y1="46.9437"
          x2="54"
          y2="51.0563"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint4_linear"
          x1="96"
          y1="0.943728"
          x2="96"
          y2="5.05625"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint5_linear"
          x1="101"
          y1="10.9719"
          x2="101"
          y2="13.0281"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint6_linear"
          x1="86"
          y1="14.9437"
          x2="86"
          y2="19.0563"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint7_linear"
          x1="74"
          y1="25.9437"
          x2="74"
          y2="30.0563"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint8_linear"
          x1="85"
          y1="27.9437"
          x2="85"
          y2="32.0563"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint9_linear"
          x1="75"
          y1="33.9719"
          x2="75"
          y2="36.0281"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint10_linear"
          x1="64"
          y1="32.9437"
          x2="64"
          y2="37.0563"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint11_linear"
          x1="69"
          y1="42.9719"
          x2="69"
          y2="45.0281"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint12_linear"
          x1="59.5"
          y1="33.9859"
          x2="59.5"
          y2="35.0141"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint13_linear"
          x1="54"
          y1="46.9437"
          x2="54"
          y2="51.0563"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint14_linear"
          x1="96"
          y1="0.943728"
          x2="96"
          y2="5.05625"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint15_linear"
          x1="101"
          y1="10.9719"
          x2="101"
          y2="13.0281"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint16_linear"
          x1="86"
          y1="14.9437"
          x2="86"
          y2="19.0563"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint17_linear"
          x1="74"
          y1="25.9437"
          x2="74"
          y2="30.0563"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint18_linear"
          x1="85"
          y1="27.9437"
          x2="85"
          y2="32.0563"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
        <linearGradient
          id="paint19_linear"
          x1="75"
          y1="33.9719"
          x2="75"
          y2="36.0281"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#EC5D2A" />
          <stop offset="1" stopColor="#57B9AF" />
        </linearGradient>
      </defs>
    </svg>
  );
}
