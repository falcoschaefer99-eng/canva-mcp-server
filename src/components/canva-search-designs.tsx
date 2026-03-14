import React from 'react';
import { useWidgetProps } from '../hooks';
import '../styles/index.css';
import { cn } from '../lib/utils';

interface DesignUrls {
  edit_url?: string;
  view_url?: string;
}

interface DesignThumbnail {
  url?: string;
}

interface Design {
  id: string;
  title?: string;
  doctype_name?: string;
  updated_at?: string;
  thumbnail?: DesignThumbnail;
  urls?: DesignUrls;
}

interface Props extends Record<string, unknown> {
  query?: string;
  designs?: Design[];
  continuation?: string | null;
}

const CanvaSearchDesigns: React.FC = () => {
  const props = useWidgetProps<Props>({
    query: '',
    designs: [],
    continuation: null
  });

  const { query, designs, continuation } = props;

  const handleDesignClick = (design: Design) => {
    const url = design.urls?.edit_url || design.urls?.view_url;
    
    if (window.parent && window.parent.postMessage) {
      // NOTE: '*' is intentional — this widget runs inside an iframe hosted by the AI client
      // (e.g. ChatGPT, Claude), and we cannot know the parent origin at build time.
      // Callers should verify message.type before acting on received messages.
      window.parent.postMessage({
        type: 'canva-design-clicked',
        data: {
          designId: design.id,
          url,
          design
        }
      }, '*');
    }
  };

  const handleLoadMore = () => {
    if (window.parent && window.parent.postMessage) {
      // NOTE: '*' is intentional — widget iframe cannot know parent origin at build time.
      window.parent.postMessage({
        type: 'canva-load-more',
        data: { continuation }
      }, '*');
    }
  };

  if (!designs || designs.length === 0) {
    return (
      <div className="rounded-xl p-8 text-center">
        <div className="text-4xl mb-3 opacity-50">🎨</div>
        <div className="text-lg font-semibold text-gray-900 mb-2">
          No designs found
        </div>
        <div className="text-sm text-gray-600">
          Try adjusting your search criteria
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl">
      <h4 className="text-xl font-bold text-gray-900 mb-4">Search results</h4>
      
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {designs.map((design) => (
          <div
            key={design.id}
            onClick={() => handleDesignClick(design)}
            className={cn(
              "cursor-pointer rounded-lg overflow-hidden",
              "w-[192px] h-[192px]"
            )}
          >
            {/* Image container - takes most of the 192px height */}
            <div className="relative w-full h-[140px] bg-gray-100 rounded-t-lg overflow-hidden">
              <img
                src={design.thumbnail?.url || 'https://via.placeholder.com/192x140?text=No+Preview'}
                alt={design.title || 'Untitled Design'}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </div>

            {/* Design info - fixed height for remaining space */}
            <div className="h-[52px] px-2 py-1.5 flex flex-col justify-center">
              <p className="text-xs font-medium text-gray-900 line-clamp-2 leading-tight">
                {design.title || 'Untitled Design'}
              </p>
              {design.doctype_name && (
                <div className="flex items-center gap-1 text-[10px] text-gray-600 mt-0.5">
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                  </svg>
                  <span className="truncate">{design.doctype_name}</span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default CanvaSearchDesigns;








