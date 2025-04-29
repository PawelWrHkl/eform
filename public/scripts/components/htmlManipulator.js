export function createElement(tag, attributes = {}, parent = null) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
        if (key === 'text') {
            element.textContent = value;
        } 
        else if (key === 'html') {
            element.innerHTML = value;
        } 
        else if (key === 'class') {
            for (const className of value) {
                element.classList.add(className);
            }
        } 
        else if (key === 'style') {
            Object.assign(element.style, value);
        } 
        else if (key === 'type'){
            element.type = value;
        }
        else if (key === 'value'){
            element.value = value;
        } 
        else if (key === 'dataset') {
            for (const [dataKey, dataValue] of Object.entries(value)) {
                element.dataset[dataKey] = dataValue;}
        } 
        else if (key.startsWith('on')) {
            const eventType = key.slice(2).toLowerCase();
            element.addEventListener(eventType, value);
        }
        else if (key === 'checked') {
            element.checked = value;
        } 
        else if (key === 'disabled') {
            element.disabled = value;
        }  
        else if (key === 'placeholder') {
            element.placeholder = value;
        }  
        else if (key === 'src') {
            element.src = value;
        }
        else if (key === 'href') {
            element.href}    
        else {
            element.setAttribute(key, value);
        }
    }
    if (parent) {
        parent.appendChild(element);
    }
    return element;
}