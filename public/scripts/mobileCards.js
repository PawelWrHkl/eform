document.addEventListener('DOMContentLoaded', function () {
    
    function initMobileCards() {
        const mobileCards = document.querySelectorAll('.mobile-item-card');

        mobileCards.forEach(card => {
            let clickTimeout;

            
            card.addEventListener('click', function (e) {
                
                if (e.target.closest('.mobile-item-actions') ||
                    e.target.closest('button') ||
                    e.target.closest('a')) {
                    return;
                }

                
                clearTimeout(clickTimeout);

                
                clickTimeout = setTimeout(() => {
                    
                    this.classList.toggle('expanded');

                    
                    if (this.classList.contains('expanded')) {
                        this.style.transform = 'scale(1.02)';
                        setTimeout(() => {
                            this.style.transform = 'scale(1)';
                        }, 150);
                    }
                }, 250); 
            });

            
            card.addEventListener('dblclick', function (e) {
                
                clearTimeout(clickTimeout);

                
                if (e.target.closest('.mobile-item-actions') ||
                    e.target.closest('button') ||
                    e.target.closest('a')) {
                    return;
                }

                
                const positionUrl = this.getAttribute('data-position-url');
                if (positionUrl) {
                    window.location.href = positionUrl;
                }
            });

            
            if (window.innerWidth >= 768) { // 768 = desktop (jak CSS: max-width 767.98px)
                card.addEventListener('mouseenter', function () {
                    this.style.transform = 'translateY(-2px)';
                    this.style.boxShadow = '0 12px 40px rgba(0, 0, 0, 0.18)';
                });

                card.addEventListener('mouseleave', function () {
                    if (!this.classList.contains('expanded')) {
                        this.style.transform = 'translateY(0)';
                        this.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.12)';
                    }
                });
            }
        });
    }

    
    initMobileCards();

    
    window.addEventListener('resize', function () {
        
        setTimeout(initMobileCards, 100);
    });

    
    console.log('Mobile cards initialized:', document.querySelectorAll('.mobile-item-card').length);
});