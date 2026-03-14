import React, { useState, useRef } from 'react';
import { useWidgetProps } from '../hooks';
import '../styles/index.css';
import { cn } from '../lib/utils';

interface Candidate {
  id: string;
  thumbnail_url?: string;
  preview_url?: string;
  url?: string;
}

interface Props extends Record<string, unknown> {
  candidates?: Candidate[];
  job_id?: string | null;
}

const CanvaDesignGenerator: React.FC = () => {
  const props = useWidgetProps<Props>({
    candidates: [],
    job_id: null
  });

  const { candidates, job_id } = props;
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const handleSelect = (candidate: Candidate) => {
    setSelectedCandidateId(candidate.id);

    if (window.parent && window.parent.postMessage) {
      // NOTE: '*' is intentional — this widget runs inside an iframe hosted by the AI client
      // (e.g. ChatGPT, Claude), and we cannot know the parent origin at build time.
      // Callers should verify message.type before acting on received messages.
      window.parent.postMessage({
        type: 'canva-create-from-candidate',
        data: {
          jobId: job_id,
          candidateId: candidate.id,
          candidate
        }
      }, '*');
    }
  };

  const scroll = (direction: 'left' | 'right') => {
    if (scrollContainerRef.current) {
      const scrollAmount = 200;
      scrollContainerRef.current.scrollBy({
        left: direction === 'left' ? -scrollAmount : scrollAmount,
        behavior: 'smooth'
      });
    }
  };

  if (!candidates || candidates.length === 0) {
    return (
      <div className="h-[192px] rounded-xl flex items-center justify-center">
        <div className="text-center text-gray-500">
          <div className="text-4xl mb-2">🎨</div>
          <div className="text-sm font-medium">No design candidates</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[192px] rounded-xl relative">
      {/* Left scroll button */}
      <button
        onClick={() => scroll('left')}
        className={cn(
          "absolute left-2 top-1/2 -translate-y-1/2 z-10",
          "w-8 h-8 rounded-full bg-white/90 backdrop-blur-sm",
          "flex items-center justify-center shadow-lg",
          "hover:bg-white transition-all duration-200",
          "border border-gray-200"
        )}
      >
        <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      {/* Carousel container */}
      <div
        ref={scrollContainerRef}
        className="h-full overflow-x-auto overflow-y-hidden flex items-center gap-3 px-12 scrollbar-hide"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {candidates.map((candidate, index) => {
          const isSelected = selectedCandidateId === candidate.id;

          return (
            <div
              key={candidate.id}
              onClick={() => handleSelect(candidate)}
              className={cn(
                "relative flex-shrink-0 w-[192px] h-[192px] rounded-3xl overflow-hidden",
                "cursor-pointer",
                "bg-white border-2",
                isSelected ? "border-purple-500 shadow-lg" : "border-transparent"
              )}
            >
              <img
                src={candidate.thumbnail_url || candidate.preview_url || 'https://via.placeholder.com/192x192?text=Design'}
                alt={`Design ${index + 1}`}
                className="w-full h-full object-cover"
                loading="lazy"
              />
              {isSelected && (
                <div className="absolute top-2 right-2 w-6 h-6 bg-purple-500 rounded-full flex items-center justify-center">
                  <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Right scroll button */}
      <button
        onClick={() => scroll('right')}
        className={cn(
          "absolute right-2 top-1/2 -translate-y-1/2 z-10",
          "w-8 h-8 rounded-full bg-white/90 backdrop-blur-sm",
          "flex items-center justify-center shadow-lg",
          "hover:bg-white transition-all duration-200",
          "border border-gray-200"
        )}
      >
        <svg className="w-5 h-5 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

    </div>
  );
};

export default CanvaDesignGenerator;








